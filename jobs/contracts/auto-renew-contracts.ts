/**
 * #779 §A — Cron: auto-renew expiring contracts.
 *
 * Schedule: the ticker's daily window from 03:00 UTC, on a slot BEFORE
 * expire-contracts, and both select contracts ended by the window start.
 * Renewal must win the race with expiry: expire-contracts leaves an un-renewed
 * autoRenew contract alone for one day after it ends (`expiryCohortWhere`), and
 * this job flips a renewed contract to EXPIRED itself.
 *
 * Per contract due for renewal (status ACTIVE, autoRenew, effectiveTo<=now,
 * autoRenewedAt null):
 *   1. Claim by stamping autoRenewedAt (gate doubles as the distributed lock).
 *   2. Mint the RENEWAL successor (same org/billingAccount/terms; effectiveFrom
 *      = old effectiveTo; effectiveTo = +same duration; status ACTIVE;
 *      autoRenew carried).
 *   3. Set old.supersededByContractId/At + supersessionReason=RENEWAL and flip
 *      old → EXPIRED in the same tx. We expire it here (rather than leaving it
 *      ACTIVE for expire-contracts) because a contract that has been superseded
 *      is, by definition, no longer the governing term — leaving two ACTIVE
 *      contracts on one org would double-count billing.
 *
 * Concurrency: candidates findMany (bounded) → per-row Serializable
 * $transaction → conditional updateMany claim (count===0 ⇒ skip) → side effects
 * in same tx → OrgAuditLog row. Mirrors jobs/contracts/expire-contracts.ts.
 */

import prisma from "@/lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatAuditDate } from "@/lib/labels/org-labels";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { nextPeriodEnd } from "@/lib/enterprise/cycle-engine";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  attemptStaged,
  type StagedRecipientEmail as StagedEmail,
} from "@/lib/email/send-to-recipients";
import {
  ONBOARDING_EMAIL_TYPES,
  stageOrgContractAndSeatEmail,
} from "@/lib/email/senders/onboarding";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { notifyOrgContractStatusChanged } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

const BATCH_SIZE = 500;

interface RenewStats {
  scanned: number;
  renewed: number;
  skipped: number;
  failed: number;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function stageAutoRenewedNotifications(
  tx: TxClient,
  args: {
    organizationId: string;
    orgName: string;
    successorId: string;
    oldTo: Date;
  },
): Promise<{
  stagedBells: StagedTrigger[];
  stagedEmails: StagedEmail[];
}> {
  const { organizationId, orgName, successorId, oldTo } = args;
  const dashboardUrl = `${getAppUrl()}/dashboard/organization/${organizationId}/billing`;
  const operatorRows = tx.membership?.findMany
    ? await tx.membership.findMany({
        where: {
          organizationId,
          status: "ACTIVE",
          role: { in: ["OWNER", "MAINTAINER"] },
        },
        select: { userId: true },
      })
    : [];
  const stagedBells =
    (await notifyOrgContractStatusChanged(
      organizationId,
      {
        orgName,
        status: "RENEWED",
        effectiveDate: oldTo.toISOString(),
        dashboardUrl,
      },
      { tx },
    )) ?? [];
  const stagedEmails = await stageOrgContractAndSeatEmail(tx, {
    recipientUserIds: operatorRows.map((r) => r.userId),
    entityId: successorId,
    kind: "CONTRACT_RENEWED",
    orgName,
    effectiveDate: oldTo,
    dashboardUrl,
  });
  return { stagedBells, stagedEmails };
}

async function notifyAutoRenewedContract(
  contractId: string,
  stagedBells: StagedTrigger[],
  stagedEmails: StagedEmail[],
): Promise<void> {
  try {
    for (const bell of stagedBells) await attemptTrigger(bell);
    if (stagedEmails.length > 0) {
      await attemptStaged(
        stagedEmails,
        ONBOARDING_EMAIL_TYPES.ORG_CONTRACT_AND_SEAT,
        EMAIL_BUDGET_MS.JOB,
      );
    }
  } catch (notifyErr) {
    console.error(
      `[auto-renew-contracts] notify failed for contract ${contractId}:`,
      notifyErr,
    );
  }
}

/** Contracts due for renewal by `asOf`; shared by the run and the ticker's idle probe. */
function renewalDueWhere(asOf: Date): Prisma.ContractWhereInput {
  return {
    status: "ACTIVE",
    autoRenew: true,
    autoRenewedAt: null,
    effectiveTo: { lte: asOf, not: null },
  };
}

/** Ticker idle probe: the cohort at `now` covers any window start at or before it. */
export async function hasAutoRenewContractsWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.contract.findFirst({
    where: renewalDueWhere(now),
    select: { id: true },
  });
  return row !== null;
}

// fail-closed: renewal mints the next contract period the checkout sponsorship resolver reads.
export async function runAutoRenewContracts(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<RenewStats> {
  return withCronLock("auto-renew-contracts", { failMode: "closed" }, () =>
    autoRenewContracts(opts),
  );
}

/** Every candidate leaves the cohort on claim, so `limit` is a plain oldest-first bite. */
async function autoRenewContracts(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<RenewStats> {
  const failures = createRunFailureReporter("jobs");
  const stats: RenewStats = { scanned: 0, renewed: 0, skipped: 0, failed: 0 };
  const now = new Date();
  const asOf = opts.windowStart ?? now;

  const due = await prisma.contract.findMany({
    where: renewalDueWhere(asOf),
    orderBy: { effectiveTo: "asc" },
    take: opts.limit ?? BATCH_SIZE,
    select: {
      id: true,
      organizationId: true,
      billingAccountId: true,
      purchaseOrderId: true,
      effectiveFrom: true,
      effectiveTo: true,
      paymentTermsDays: true,
      autoRenew: true,
      rateCardId: true,
      organization: { select: { name: true } },
    },
  });
  stats.scanned = due.length;

  for (const c of due) {
    // effectiveTo is guaranteed non-null by the query filter.
    const oldFrom = c.effectiveFrom;
    const oldTo = c.effectiveTo as Date;
    // Same duration: successor runs [oldTo, oldTo + (oldTo - oldFrom)].
    const durationMs = oldTo.getTime() - oldFrom.getTime();
    const newTo = new Date(oldTo.getTime() + durationMs);

    try {
      // #1132 follow-up — transient P2034 aborts now retry; persistent ones
      // keep the outer catch's skip semantics (next-day recovery).
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            // Claim: stamp autoRenewedAt only while still ACTIVE + unstamped.
            const claim = await tx.contract.updateMany({
              where: { id: c.id, status: "ACTIVE", autoRenewedAt: null },
              data: { autoRenewedAt: now },
            });
            if (claim.count === 0) return { renewed: false as const };

            const successor = await tx.contract.create({
              data: {
                organizationId: c.organizationId,
                billingAccountId: c.billingAccountId,
                purchaseOrderId: c.purchaseOrderId,
                status: "ACTIVE",
                signedAt: now,
                effectiveFrom: oldTo,
                effectiveTo: newTo,
                paymentTermsDays: c.paymentTermsDays,
                autoRenew: c.autoRenew,
                rateCardId: c.rateCardId,
              },
            });

            // Re-point the old contract's programs to the successor — without
            // this, the cycle engine sees their contract as non-ACTIVE at the
            // next periodEnd and CLOSEs every assignment instead of rolling,
            // which would defeat the renewal. Invoices keep their old
            // contractId (the money trail stays on the term that billed them).
            await tx.program.updateMany({
              where: { contractId: c.id },
              data: { contractId: successor.id },
            });

            // E2E-audit P0 fix — LICENSE CONTINUITY on renewal. Carry the
            // BillingSubscription onto the renewed term (same re-pointing the
            // manual supersede route does); leaving it stranded froze seat
            // counts and left the renewed term unlicensed. The billing clock
            // restarts at the new term start; no row is deleted.
            const oldSubscription = await tx.billingSubscription.findUnique({
              where: { contractId: c.id },
            });
            if (oldSubscription) {
              const subCycleEnd = nextPeriodEnd(oldTo, oldSubscription.cycle);
              await tx.billingSubscription.update({
                where: { id: oldSubscription.id },
                data: {
                  contractId: successor.id,
                  currentCycleStart: oldTo,
                  currentCycleEnd: subCycleEnd,
                  nextInvoiceDate: subCycleEnd,
                  startsAt: oldTo,
                  endsAt: newTo,
                  renewalReminderSentAt: null,
                },
              });
            }

            // Link supersession chain + retire the old contract. EXPIRED here
            // (not left ACTIVE) so expire-contracts has nothing to do.
            await tx.contract.update({
              where: { id: c.id },
              data: {
                status: "EXPIRED",
                supersededByContractId: successor.id,
                supersededAt: now,
                supersessionReason: "RENEWAL",
              },
            });

            await tx.orgAuditLog.create({
              data: {
                organizationId: c.organizationId,
                actorMembershipId: null,
                targetMembershipId: null,
                category: "CONTRACT",
                action: AUDIT_ACTIONS.CONTRACT.CONTRACT_AUTO_RENEWED,
                description: `Contract auto-renewed (${formatAuditDate(oldTo)} → ${formatAuditDate(newTo)})`,
                details: {
                  contractId: c.id,
                  successorContractId: successor.id,
                  effectiveFrom: oldTo.toISOString(),
                  effectiveTo: newTo.toISOString(),
                },
              },
            });

            await dispatchWebhookEvent({
              prisma: tx,
              organizationId: c.organizationId,
              eventType: "contract.signed",
              payload: {
                contractId: successor.id,
                billingAccountId: c.billingAccountId,
                status: "ACTIVE",
                signedAt: now.toISOString(),
                effectiveFrom: oldTo.toISOString(),
                effectiveTo: newTo.toISOString(),
                supersededContractId: c.id,
                reason: "RENEWAL",
              },
            });

            const { stagedBells, stagedEmails } =
              await stageAutoRenewedNotifications(tx, {
                organizationId: c.organizationId,
                orgName: c.organization?.name ?? "Organization",
                successorId: successor.id,
                oldTo,
              });

            return {
              renewed: true as const,
              successorId: successor.id,
              stagedBells,
              stagedEmails,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );

      if (result.renewed) {
        stats.renewed += 1;
        await notifyAutoRenewedContract(
          c.id,
          result.stagedBells,
          result.stagedEmails,
        );
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      // supersededByContractId @unique tripped — another replica already
      // renewed this contract. Idempotent; skip cleanly.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        stats.skipped += 1;
        continue;
      }
      failures.add("auto-renew-contracts", err, { contractId: c.id });
      console.error(`[auto-renew-contracts] Failed for contract ${c.id}:`, err);
      stats.failed += 1;
    }
  }

  failures.flush();
  return stats;
}
