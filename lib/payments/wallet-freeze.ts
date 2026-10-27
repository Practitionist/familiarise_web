/**
 * #837 — wallet-spend freeze, scoped to a single drifted BillingAccount.
 *
 * When the ledger-reconcile job finds WALLET_BALANCE_DRIFT (cached
 * `BillingAccount.walletBalance` ≠ the journal's WALLET account) the balance is
 * no longer trustworthy, so we must stop spending it until ops reconciles.
 *
 * There is no schema column for a per-wallet freeze and the launch schema is
 * frozen, so the freeze rides the existing append-only `SystemEvent` log rather
 * than a new column/table:
 *   - the freeze KEY is the indexed `correlationId` = `wallet-freeze:<billingAccountId>`,
 *   - the current state is the category of the LATEST event under that key
 *     (WALLET_FREEZE → frozen, WALLET_UNFREEZE → cleared).
 * FREEZE is set by the reconcile job or an ops door; UNFREEZE is an ops action,
 * or the reconcile job lifting its own drift-tagged FREEZE once the cache equals
 * the journal again. The check is a single indexed DB read inside the caller's tx,
 * so it fails CLOSED — an unreadable log blocks the spend rather than leaking it.
 *
 * #1205-triage — these writes are ERROR-PROPAGATING, unlike recordSystemEvent
 * (which swallows insert failures for operator surfaces). The freeze/unfreeze
 * pair IS the kill-switch state: a silently-dropped FREEZE leaves spend open;
 * a dropped UNFREEZE told the admin the account was released when it wasn't.
 *
 * Deliberately gates only discretionary SPEND (the checkout booking debit), not
 * chargeback recovery (app/api/webhooks/utils.ts): a lost-dispute debit recovers
 * money the bank already pulled and must not be stranded on a drift freeze.
 */

import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { createRunFailureReporter } from "@/lib/observability/run-failures";

const FREEZE_CATEGORY = "WALLET_FREEZE";
const UNFREEZE_CATEGORY = "WALLET_UNFREEZE";
const freezeKey = (billingAccountId: string) =>
  `wallet-freeze:${billingAccountId}`;
/** Marks a FREEZE written by the reconcile drift response; only these auto-release. */
const DRIFT_FREEZE_SOURCE = "reconcile-drift";
const freezeContextSchema = z.object({ source: z.string().optional() });

export class WalletFrozenError extends Error {
  public readonly httpStatus = 409;
  constructor(public billingAccountId: string) {
    super(
      `Wallet spend frozen on billing account ${billingAccountId} pending ledger-drift resolution`,
    );
    this.name = "WalletFrozenError";
  }
}

/** True when the account's latest freeze event is a FREEZE. Reads inside the
 *  caller's tx/client so the check shares the spend's snapshot. */
export async function isWalletFrozen(
  db: Pick<typeof prisma, "systemEvent">,
  billingAccountId: string,
): Promise<boolean> {
  const latest = await db.systemEvent.findFirst({
    where: {
      correlationId: freezeKey(billingAccountId),
      category: { in: [FREEZE_CATEGORY, UNFREEZE_CATEGORY] },
    },
    orderBy: { createdAt: "desc" },
    select: { category: true },
  });
  return latest?.category === FREEZE_CATEGORY;
}

interface FreezeWriteParams {
  billingAccountId: string;
  organizationId?: string | null;
}

type FreezeParams = FreezeWriteParams & {
  reason: string;
  source?: typeof DRIFT_FREEZE_SOURCE;
};

function freezeEventData(params: FreezeParams) {
  return {
    organizationId: params.organizationId ?? null,
    category: FREEZE_CATEGORY,
    severity: "ERROR" as const,
    message: `Wallet spend FROZEN for billing account ${params.billingAccountId}: ${params.reason}`,
    context: {
      billingAccountId: params.billingAccountId,
      reason: params.reason,
      ...(params.source ? { source: params.source } : {}),
    } as Prisma.InputJsonObject,
    correlationId: freezeKey(params.billingAccountId),
  };
}

/** Freeze wallet spend for one account. Idempotent — no-op if already frozen.
 *  Write failures PROPAGATE (see #1205-triage note above); the reconcile job's
 *  own error handling pages on them. Returns true when it wrote a new event. */
export async function freezeWalletSpend(
  params: FreezeParams,
): Promise<boolean> {
  if (await isWalletFrozen(prisma, params.billingAccountId)) return false;
  await prisma.systemEvent.create({ data: freezeEventData(params) });
  return true;
}

/** Unfreeze wallet spend for one account; called by the admin unfreeze door
 *  and by `releaseReconciledWalletFreezes`.
 *
 *  #1205-triage — atomic under Serializable: the frozen-check and the
 *  UNFREEZE write share one tx, so a reconciler re-freezing concurrently
 *  (fresh drift discovered between our read and write) aborts us instead of
 *  being silently cleared by a later-dated UNFREEZE. Returns false (409 at
 *  the route) when not frozen or when the concurrent-write abort fires.
 *  Write failures propagate. */
export async function unfreezeWalletSpend(
  params: FreezeWriteParams & {
    actorUserId: string;
    reason: string;
    /** Release only while this drift FREEZE is still the account's latest event. */
    expectedDriftFreezeId?: string;
  },
): Promise<boolean> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const releasable = params.expectedDriftFreezeId
          ? (await latestDriftFreezeIds(tx, [params.billingAccountId])).get(
              params.billingAccountId,
            ) === params.expectedDriftFreezeId
          : await isWalletFrozen(tx, params.billingAccountId);
        if (!releasable) return false;
        await tx.systemEvent.create({
          data: {
            organizationId: params.organizationId ?? null,
            category: UNFREEZE_CATEGORY,
            severity: "INFO",
            message: `Wallet spend UNFROZEN for billing account ${params.billingAccountId} by ${params.actorUserId}: ${params.reason}`,
            context: {
              billingAccountId: params.billingAccountId,
              reason: params.reason,
              unfrozenBy: params.actorUserId,
            } as Prisma.InputJsonObject,
            correlationId: freezeKey(params.billingAccountId),
          },
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // SSI abort = a concurrent freeze/unfreeze interleaved with us. Surface
    // as not-applied rather than throwing out of an admin route.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      return false;
    }
    throw err;
  }
}

export interface FrozenWallet {
  billingAccountId: string;
  organizationId: string | null;
  deltaPaise: number;
  newlyFrozen: boolean;
}

/**
 * Freezes spend on every WALLET_BALANCE_DRIFT account of one reconcile report,
 * the same for every door that runs a reconcile. Appends to `frozen` as it goes;
 * one failed freeze does not stop the rest, and the failures throw together at the end.
 */
export async function freezeDriftedWallets(
  report: {
    id: string;
    findings: ReadonlyArray<{
      kind: string;
      billingAccountId?: string;
      organizationId?: string;
      expectedPaise: number;
      actualPaise: number;
      deltaPaise: number;
    }>;
  },
  frozen: FrozenWallet[] = [],
): Promise<FrozenWallet[]> {
  const failures: unknown[] = [];
  for (const f of report.findings) {
    if (f.kind !== "WALLET_BALANCE_DRIFT" || !f.billingAccountId) continue;
    try {
      const newlyFrozen = await freezeWalletSpend({
        billingAccountId: f.billingAccountId,
        organizationId: f.organizationId ?? null,
        reason: `ledger reconcile ${report.id}: wallet cache ${f.actualPaise}p ≠ journal ${f.expectedPaise}p (Δ${f.deltaPaise}p)`,
        source: DRIFT_FREEZE_SOURCE,
      });
      frozen.push({
        billingAccountId: f.billingAccountId,
        organizationId: f.organizationId ?? null,
        deltaPaise: Number(f.deltaPaise),
        newlyFrozen,
      });
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Wallet freeze failed for ${failures.length} drifting account(s): ${failures
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ")}`,
    );
  }
  return frozen;
}

export interface WalletAccountRef {
  billingAccountId: string;
  organizationId: string | null;
  /** The drift FREEZE that is the account's latest event in the reading snapshot, if any. */
  driftFreezeId: string | null;
}

/**
 * Per account, the id of its latest freeze event when that event is a FREEZE
 * the reconcile drift response wrote. Ops freezes and untagged freezes are absent.
 */
export async function latestDriftFreezeIds(
  db: Pick<typeof prisma, "systemEvent">,
  billingAccountIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (billingAccountIds.length === 0) return out;
  const events = await db.systemEvent.findMany({
    where: {
      correlationId: { in: billingAccountIds.map(freezeKey) },
      category: { in: [FREEZE_CATEGORY, UNFREEZE_CATEGORY] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, correlationId: true, category: true, context: true },
  });
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.correlationId || seen.has(e.correlationId)) continue;
    seen.add(e.correlationId);
    const source = freezeContextSchema.safeParse(e.context).data?.source;
    if (e.category === FREEZE_CATEGORY && source === DRIFT_FREEZE_SOURCE) {
      out.set(e.correlationId.slice("wallet-freeze:".length), e.id);
    }
  }
  return out;
}

/**
 * Lifts a drift freeze the reconcile snapshot saw as latest on an account whose
 * cache equals its journal; the CAS re-checks that event inside the unfreeze.
 * A failed release leaves spend frozen and reports once per call.
 */
export async function releaseReconciledWalletFreezes(
  reportId: string,
  inSync: readonly WalletAccountRef[],
): Promise<string[]> {
  const released: string[] = [];
  const failures = createRunFailureReporter("payments");
  for (const account of inSync) {
    if (!account.driftFreezeId) continue;
    try {
      const applied = await unfreezeWalletSpend({
        billingAccountId: account.billingAccountId,
        organizationId: account.organizationId,
        actorUserId: "SYSTEM",
        reason: `ledger reconcile ${reportId}: wallet cache equals journal`,
        expectedDriftFreezeId: account.driftFreezeId,
      });
      if (applied) released.push(account.billingAccountId);
    } catch (err) {
      failures.add("wallet-freeze.auto-release", err, {
        billingAccountId: account.billingAccountId,
      });
    }
  }
  failures.flush();
  return released;
}
