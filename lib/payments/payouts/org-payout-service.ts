/**
 * Organization Payout Service — full rewrite (#713-2 / #700 LED-4).
 *
 * Replaces the prior @arch4-stub. The service exposes three operations
 * that crons + the org-payouts route share so org-level batching has a
 * single source of truth:
 *
 *   - getOrgPayoutEligibility(orgId)
 *       Read-only check: does this org have a verified payout account
 *       and any READY OrganizationEarnings? Returns shape callers can
 *       safely render in a dashboard ("you have ₹X ready, Y rows").
 *
 *   - createOrgPayoutBatch(orgId, periodStart, periodEnd, opts?)
 *       Atomic batch creation: claim READY earnings, compute aggregated
 *       totals, write the OrganizationPayout (status DRAFT/PENDING),
 *       flip the claimed earnings to PAID, write SettlementLedgerEntry
 *       + audit log. Optionally accepts an `idempotencyKey` so cron
 *       retries become no-ops via the unique constraint.
 *
 *   - processOrgPayout(payoutId)
 *       State machine progression: PENDING → PROCESSING → COMPLETED |
 *       FAILED. Today only progresses PENDING → PROCESSING and writes
 *       the audit log + SettlementLedgerEntry; live RazorpayX /
 *       Stripe Connect submission is gated on `ENABLE_LIVE_PAYOUTS` and
 *       lands in PR-3.
 *
 *   - markOrgPayoutCompleted(payoutId)
 *       Idempotent PROCESSING → COMPLETED transition + Novu fire to the
 *       visibility roster. Called by the gateway-webhook reconciler
 *       (PR-3); kept here so the notification dispatch is co-located with
 *       the state change (closes #718 / BUG-017).
 *
 * Atomicity:
 *   - createOrgPayoutBatch acquires a Redis lock keyed by orgId so two
 *     concurrent callers (cron + UI button + manual replay) cannot both
 *     start a batch for the same org. Inside the lock the DB tx is
 *     Serializable for phantom-read safety.
 *   - The earnings claim step is a conditional UPDATE that only catches
 *     rows still NULL on `orgPayoutId` — even without the Redis lock
 *     this prevents double-claiming. The lock buys us deterministic
 *     ordering and a clean error path.
 *
 * India statutory compliance (TDS / MSME / Form15 / FIRC):
 *   - Stub helpers in lib/compliance/{tds,msme,form15} are called so
 *     downstream rows have non-null defaults. Live derivation lands in
 *     PR-2 (India compliance go-live). The cron at
 *     `jobs/compliance/derive-tds-msme.ts` (also part of PR-2) will
 *     re-derive these for any rows still on stub defaults.
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentGateway, PayoutStatus } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { computeMsmePaymentDeadline } from "@/lib/compliance/msme";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgPayoutCompleted } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

export class PayoutLockError extends Error {
  readonly code = "PAYOUT_LOCK_CONFLICT" as const;
  constructor(message?: string) {
    super(
      message ??
        "Another payout batch is being created for this organization. Please try again.",
    );
    this.name = "PayoutLockError";
  }
}

export class PayoutValidationError extends Error {
  readonly code = "PAYOUT_VALIDATION_FAILED" as const;
  constructor(
    message: string,
    public httpStatus = 409,
  ) {
    super(message);
    this.name = "PayoutValidationError";
  }
}

export interface OrgPayoutEligibility {
  eligible: boolean;
  readyAmount: number;
  earningsCount: number;
  payoutAccountStatus: string | null;
  reason?: string;
}

export interface OrgPayoutBatchResult {
  payoutId: string;
  amountPaise: number;
  earningsCount: number;
  periodStart: Date;
  periodEnd: Date;
  alreadyExisted?: boolean;
}

export interface CreateOrgPayoutBatchOptions {
  /** Channel used to push the funds (RazorpayX is the v1 default). */
  paymentGateway?: PaymentGateway;
  /** Cron-safe duplicate guard. When set, a row with the same key
   *  short-circuits to an idempotent response instead of creating a dup. */
  idempotencyKey?: string;
  /** Free-form audit notes; surfaces on SettlementLedgerEntry. */
  notes?: string;
  /** Membership id to attribute on the audit log; null for cron runs. */
  actorMembershipId?: string | null;
}

const PAYOUT_LOCK_TTL_MS = 60_000;

/**
 * Read-only eligibility probe. Safe to call from a dashboard render path.
 * Does NOT mutate any state.
 */
export async function getOrgPayoutEligibility(
  orgId: string,
): Promise<OrgPayoutEligibility> {
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: { status: true },
  });

  if (!account) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: null,
      reason: "No payout account configured",
    };
  }

  if (account.status !== "VERIFIED") {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: account.status,
      reason: `Payout account is ${account.status} — must be VERIFIED to receive funds`,
    };
  }

  const ready = await prisma.organizationEarnings.aggregate({
    where: {
      organizationId: orgId,
      status: "READY",
      orgPayoutId: null,
    },
    _sum: { orgSharePaise: true, refundedAmountPaise: true },
    _count: true,
  });

  const orgShareSum = ready._sum.orgSharePaise ?? 0;
  const refundsSum = ready._sum.refundedAmountPaise ?? 0;
  const readyAmount = orgShareSum - refundsSum;

  if (ready._count === 0 || readyAmount <= 0) {
    return {
      eligible: false,
      readyAmount: Math.max(0, readyAmount),
      earningsCount: ready._count,
      payoutAccountStatus: account.status,
      reason:
        ready._count === 0
          ? "No READY earnings to batch"
          : `Net payout would be ${readyAmount} paise after refunds — reconcile first`,
    };
  }

  return {
    eligible: true,
    readyAmount,
    earningsCount: ready._count,
    payoutAccountStatus: account.status,
  };
}

/**
 * Atomic batch creation. Acquires a Redis lock + Serializable tx so two
 * concurrent callers cannot both start a batch for the same org.
 *
 * If `idempotencyKey` is provided and a row already exists with that
 * key, returns the existing payout's identity with `alreadyExisted: true`.
 * This is the cron-safe path: a retried weekly run is a no-op.
 */
export async function createOrgPayoutBatch(
  orgId: string,
  periodStart: Date,
  periodEnd: Date,
  opts: CreateOrgPayoutBatchOptions = {},
): Promise<OrgPayoutBatchResult> {
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new PayoutValidationError(
      "periodEnd must be after periodStart",
      400,
    );
  }

  // Idempotency short-circuit: cheaper than acquiring the lock just to
  // bounce on the unique constraint.
  if (opts.idempotencyKey) {
    const existing = await prisma.organizationPayout.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        id: true,
        amountPaise: true,
        periodStart: true,
        periodEnd: true,
        earnings: { select: { id: true } },
      },
    });
    if (existing) {
      return {
        payoutId: existing.id,
        amountPaise: existing.amountPaise,
        earningsCount: existing.earnings.length,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        alreadyExisted: true,
      };
    }
  }

  const lockKey = `org:${orgId}:payout-batch`;
  const token = await acquireLock(lockKey, PAYOUT_LOCK_TTL_MS);
  if (!token) {
    throw new PayoutLockError();
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const payoutAccount = await tx.organizationPayoutAccount.findUnique({
          where: { organizationId: orgId },
        });
        if (!payoutAccount) {
          throw new PayoutValidationError(
            "No payout account configured for this organization",
            409,
          );
        }
        if (payoutAccount.status !== "VERIFIED") {
          throw new PayoutValidationError(
            `Payout account is ${payoutAccount.status} — cannot create payouts until VERIFIED`,
            409,
          );
        }

        // Race-safe claim: create placeholder, then atomically claim
        // READY earnings into it. Same proven pattern as the
        // /api/organizations/[orgId]/payouts route.
        const created = await tx.organizationPayout.create({
          data: {
            organizationId: orgId,
            amountPaise: 0,
            currency: "INR",
            status: "PENDING",
            paymentGateway: opts.paymentGateway ?? "RAZORPAY",
            periodStart,
            periodEnd,
            grossRevenuePaise: 0,
            platformFeePaise: 0,
            refundsPaise: 0,
            netPayoutPaise: 0,
            idempotencyKey: opts.idempotencyKey ?? null,
            // MSME deadline is derived now from a stub. The PR-2
            // compliance cron re-derives this and TDS / Form 15 fields
            // for any row still on stub defaults.
            mustPayByDate: computeMsmePaymentDeadline({
              invoiceDate: new Date(),
              msmeStatus: "NONE",
              writtenAgreement: false,
            }),
          },
        });

        const claim = await tx.organizationEarnings.updateMany({
          where: {
            organizationId: orgId,
            status: "READY",
            orgPayoutId: null,
            createdAt: { gte: periodStart, lt: periodEnd },
          },
          data: { orgPayoutId: created.id },
        });
        if (claim.count === 0) {
          throw new PayoutValidationError(
            "No READY earnings in the requested window",
            409,
          );
        }

        const readyEarnings = await tx.organizationEarnings.findMany({
          where: { orgPayoutId: created.id },
          select: {
            id: true,
            grossAmountPaise: true,
            platformFeePaise: true,
            orgSharePaise: true,
            refundedAmountPaise: true,
            currency: true,
          },
        });
        const first = readyEarnings[0];
        if (!first) {
          throw new PayoutValidationError(
            "No READY earnings in the requested window",
            409,
          );
        }
        const mixedCurrency = readyEarnings.some(
          (e) => e.currency !== first.currency,
        );
        if (mixedCurrency) {
          throw new PayoutValidationError(
            "Cannot roll earnings in mixed currencies into a single payout. Split the window.",
            409,
          );
        }

        const totals = readyEarnings.reduce(
          (acc, e) => {
            acc.gross += e.grossAmountPaise;
            acc.platformFee += e.platformFeePaise;
            acc.orgShare += e.orgSharePaise;
            acc.refunds += e.refundedAmountPaise;
            return acc;
          },
          { gross: 0, platformFee: 0, orgShare: 0, refunds: 0 },
        );
        const netPayout = totals.orgShare - totals.refunds;
        if (netPayout <= 0) {
          throw new PayoutValidationError(
            `Net payout would be ${netPayout} paise — refunds exceed earnings. Reconcile first.`,
            409,
          );
        }

        await tx.organizationPayout.update({
          where: { id: created.id },
          data: {
            amountPaise: netPayout,
            currency: first.currency,
            grossRevenuePaise: totals.gross,
            platformFeePaise: totals.platformFee,
            refundsPaise: totals.refunds,
            netPayoutPaise: netPayout,
          },
        });

        await tx.organizationEarnings.updateMany({
          where: { orgPayoutId: created.id, status: "READY" },
          data: { status: "PAID" },
        });

        await tx.settlementLedgerEntry.create({
          data: {
            organizationId: orgId,
            payoutId: created.id,
            kind: "PAYOUT_SENT",
            amountPaise: -netPayout,
            currency: first.currency,
            notes:
              opts.notes ??
              `Payout batch created — ${readyEarnings.length} earnings rolled up`,
          },
        });

        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: opts.actorMembershipId ?? null,
            category: "PAYOUT",
            action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
            description: `Payout batch created: ${readyEarnings.length} earnings, net ${netPayout} paise ${first.currency}`,
            details: {
              payoutId: created.id,
              earningsCount: readyEarnings.length,
              netPayoutPaise: netPayout,
              grossPaise: totals.gross,
              platformFeePaise: totals.platformFee,
              refundsPaise: totals.refunds,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          },
        });

        return {
          payoutId: created.id,
          amountPaise: netPayout,
          earningsCount: readyEarnings.length,
          periodStart,
          periodEnd,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 25_000,
      },
    );

    return result;
  } catch (err) {
    // P2002 on idempotencyKey — a sibling cron worker landed first while
    // we were holding the lock-but-not-the-tx. Read the winner and
    // return it as-if-existing.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      opts.idempotencyKey
    ) {
      const existing = await prisma.organizationPayout.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
        select: {
          id: true,
          amountPaise: true,
          periodStart: true,
          periodEnd: true,
          earnings: { select: { id: true } },
        },
      });
      if (existing) {
        return {
          payoutId: existing.id,
          amountPaise: existing.amountPaise,
          earningsCount: existing.earnings.length,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
          alreadyExisted: true,
        };
      }
    }
    throw err;
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Move a payout through its state machine. Today only progresses
 * `PENDING → PROCESSING` and writes the audit trail; live gateway
 * submission lands in PR-3 behind the `ENABLE_LIVE_PAYOUTS` flag.
 *
 * Idempotent: if the payout is not in PENDING the function logs and
 * returns the current status without throwing.
 */
export async function processOrgPayout(
  payoutId: string,
): Promise<{ status: PayoutStatus; submittedToGateway: boolean }> {
  const liveEnabled = process.env.ENABLE_LIVE_PAYOUTS === "true";

  return prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(
          `Payout ${payoutId} not found`,
          404,
        );
      }
      console.log(
        `[OrgPayoutService] processOrgPayout no-op: payout ${payoutId} status=${current.status}`,
      );
      return { status: current.status, submittedToGateway: false };
    }

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        amountPaise: true,
        currency: true,
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_PROCESSED,
        description: `Payout ${payoutId} moved PENDING → PROCESSING`,
        details: {
          payoutId,
          amountPaise: payout.amountPaise,
          currency: payout.currency,
          liveSubmissionEnabled: liveEnabled,
        },
      },
    });

    // Live gateway submission gated on env flag — PR-3 wires actual
    // RazorpayX `payouts.create` call and webhook reconciler that flips
    // PROCESSING → COMPLETED on success. The reconciler should call
    // `markOrgPayoutCompleted(payoutId)` below (closes #718 / BUG-017
    // by co-locating the Novu fire with the state transition).
    if (!liveEnabled) {
      return { status: "PROCESSING" as const, submittedToGateway: false };
    }
    throw new PayoutValidationError(
      "ENABLE_LIVE_PAYOUTS is set but live gateway submission has not yet shipped (see PR-3 tracker).",
      501,
    );
  });
}

/**
 * Idempotent PROCESSING → COMPLETED transition for an OrganizationPayout.
 *
 * Called by the gateway-webhook reconciler that PR-3 wires up; the
 * notification fire is intentionally co-located with the state change so
 * future call sites cannot forget to dispatch (#718 / BUG-017 root cause).
 *
 * Idempotency: the conditional updateMany only progresses rows still in
 * PROCESSING. A duplicate webhook delivery returns `wasNoOp: true` and
 * the notification is NOT re-sent.
 *
 * Notification: fired AFTER the transaction commits so a rolled-back
 * transition cannot page the visibility roster. `notifyOrgPayoutCompleted`
 * is non-throwing per its own contract.
 */
export async function markOrgPayoutCompleted(payoutId: string): Promise<{
  wasNoOp: boolean;
  status: PayoutStatus;
}> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(
          `Payout ${payoutId} not found`,
          404,
        );
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutCompleted no-op: payout ${payoutId} status=${current.status}`,
      );
      return { wasNoOp: true, status: current.status, notify: null };
    }

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_COMPLETED,
        description: `Payout ${payoutId} moved PROCESSING → COMPLETED`,
        details: {
          payoutId,
          netPayoutPaise: payout.netPayoutPaise,
          currency: payout.currency,
        },
      },
    });

    return {
      wasNoOp: false,
      status: "COMPLETED" as PayoutStatus,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
    };
  });

  if (result.notify) {
    await notifyOrgPayoutCompleted(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.netPayoutPaise,
      currency: result.notify.currency,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}
