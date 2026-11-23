/**
 * Organization Payout Service
 *
 * Orchestrates organization-level payout eligibility checks, atomic batch
 * creation (`READY → BATCHED`), gateway submission (`APPROVED → PROCESSING`),
 * stale-processing reconciliation, and completion/failure/reversal transitions.
 */

import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  recordSystemErrorSafe,
  recordSystemEventSafe,
} from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentGateway, PayoutStatus } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { assertPayoutBalance } from "./balance-preflight";
import { PAYOUT_CONSTANTS } from "./constants";
import { isMakerCheckerDisbursementBlocked } from "./maker-checker";
import {
  payoutAccountChangedAt,
  payoutAccountHold,
} from "./payout-requirements";
import {
  getIndianFinancialYear,
  recordOrgTDSDeduction,
  recordOrgTdsReversal,
} from "@/lib/payments/tax/tds-service";
import { resolveEffectiveTdsRate } from "@/lib/compliance/tds";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  clawbackRecoveredPaise,
  recoverClawbackOnPayout,
  recoverablePaise,
  releaseClawbackRecovery,
  voidClawbacksRaisedOnPayout,
} from "./clawback-recovery";
import {
  orgClawbackNetOfTds,
  postPayoutClawback,
} from "@/lib/payments/operations/reversal-engine";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { PAYOUT_ALLOWED_FROM } from "@/lib/enterprise/transitions";
import {
  VISIBILITY_ROLES,
  notifyOrgPayoutCompleted,
  notifyOrgPayoutFailed,
} from "@/lib/novu/org-workflows";
import { formatNotificationMoney } from "@/lib/novu/humanize";
import { tdsSectionLabel } from "@/lib/labels/org-labels";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { sendOrgPayoutFailedEmail } from "@/lib/email";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  MONEY_EMAIL_TYPES,
  stagePayoutStatusEmail,
} from "@/lib/email/senders/money";
import {
  attemptStaged as attemptStagedEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import { getAppUrl } from "@/lib/url";
import { payoutNoticeReason } from "@/lib/dashboard/earnings-state";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  buildPayoutCompletionPostings,
  buildPayoutReversalPostings,
  classifyGatewaySubmissionError,
  computeResidentPayoutTds,
  DISPUTE_GATED_PAYMENT_WHERE,
  PayoutMakerCheckerError,
  REFUND_GATED_PAYMENT_WHERE,
  resolveCompletionTdsWindow,
  resolvePayoutMsmeDeadline,
} from "./shared-lifecycle";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";

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

/** Nothing was sent: the destination changed after mint, so the earnings need a fresh, re-approved payout. */
export class OrgPayoutAccountChangedError extends PayoutValidationError {
  constructor(payoutId: string) {
    super(
      `Payout ${payoutId}: the payout account changed after this payout was minted — refusing to submit`,
      409,
    );
    this.name = "OrgPayoutAccountChangedError";
  }
}

/**
 * Raised when an OrganizationPayout's withholding identity
 * (`amountPaise + tdsAmountPaise === netPayoutPaise`) or non-negative invariant
 * is violated when posting the ORG_PAYOUT journal.
 */
export class OrgPayoutWithholdingMismatchError extends Error {
  readonly code = "ORG_PAYOUT_WITHHOLDING_MISMATCH" as const;
  constructor(
    readonly payoutId: string,
    readonly organizationId: string,
    readonly netPayoutPaise: number,
    readonly amountPaise: number,
    readonly tdsAmountPaise: number,
  ) {
    super(
      `Org payout ${payoutId} withholding identity violated: amountPaise ${amountPaise} + tdsAmountPaise ${tdsAmountPaise} !== netPayoutPaise ${netPayoutPaise}`,
    );
    this.name = "OrgPayoutWithholdingMismatchError";
  }
}

/** `amountPaise + tdsAmountPaise + recoveredPaise === netPayoutPaise`, recovery being the netted clawback. */
function assertOrgPayoutWithholdingIdentity(
  payout: {
    id: string;
    organizationId: string;
    netPayoutPaise: number;
    amountPaise: number;
    tdsAmountPaise: number | null;
  },
  recoveredPaise: number,
): void {
  const tds = payout.tdsAmountPaise ?? 0;
  const isNegative =
    payout.netPayoutPaise < 0 || payout.amountPaise < 0 || tds < 0;
  if (
    isNegative ||
    payout.amountPaise + tds + recoveredPaise !== payout.netPayoutPaise
  ) {
    throw new OrgPayoutWithholdingMismatchError(
      payout.id,
      payout.organizationId,
      payout.netPayoutPaise,
      payout.amountPaise,
      tds,
    );
  }
}

/** Reports a withholding-identity violation outside the transaction so PG_POOL_MAX=1 cannot deadlock. */
async function reportOrgPayoutWithholdingMismatch(
  err: OrgPayoutWithholdingMismatchError,
  op: string,
): Promise<void> {
  const context = {
    orgPayoutId: err.payoutId,
    organizationId: err.organizationId,
    netPayoutPaise: err.netPayoutPaise,
    amountPaise: err.amountPaise,
    tdsAmountPaise: err.tdsAmountPaise,
  };
  await recordSystemErrorSafe({
    organizationId: err.organizationId,
    category: "PAYOUT",
    summary: `${err.code} — org payout journal refused: amountPaise + tdsAmountPaise does not equal netPayoutPaise`,
    err,
    context,
  });
  reportSentryError(err, {
    subsystem: "payments",
    op,
    extra: context,
  });
}

interface OrgPayoutEligibility {
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
  paymentGateway?: PaymentGateway;
  idempotencyKey?: string;
  notes?: string;
  actorMembershipId?: string | null;
  createdBy?: string;
}

const PAYOUT_LOCK_TTL_MS = 60_000;

export async function getOrgPayoutEligibility(
  orgId: string,
): Promise<OrgPayoutEligibility> {
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: { status: true, payoutsAllowedAfter: true, payoutsFrozenAt: true },
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

  const hold = payoutAccountHold(account);
  if (hold) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: account.status,
      reason: hold,
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

  const orgShareSum = sumPaise(ready._sum.orgSharePaise);
  const refundsSum = sumPaise(ready._sum.refundedAmountPaise);
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

export async function createOrgPayoutBatch(
  orgId: string,
  periodStart: Date,
  periodEnd: Date,
  opts: CreateOrgPayoutBatchOptions = {},
): Promise<OrgPayoutBatchResult> {
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new PayoutValidationError("periodEnd must be after periodStart", 400);
  }
  if (opts.paymentGateway && opts.paymentGateway !== "RAZORPAY") {
    throw new PayoutValidationError(
      `Organisation payouts disburse through RazorpayX only; ${opts.paymentGateway} cannot be used.`,
      400,
    );
  }

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
    const result = await withSerializableRetry(
      () =>
        prisma.$transaction(
          async (tx) => {
            const payoutAccount = await tx.organizationPayoutAccount.findUnique(
              {
                where: { organizationId: orgId },
              },
            );
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
            const hold = payoutAccountHold(payoutAccount);
            if (hold) {
              throw new PayoutValidationError(
                `${hold}: the payout account cannot receive payouts yet`,
                409,
              );
            }

            const created = await tx.organizationPayout.create({
              data: {
                organizationId: orgId,
                amountPaise: 0,
                currency: "INR",
                status: "PENDING",
                paymentGateway: "RAZORPAY",
                periodStart,
                periodEnd,
                grossRevenuePaise: 0,
                platformFeePaise: 0,
                refundsPaise: 0,
                netPayoutPaise: 0,
                createdBy: opts.createdBy ?? "SYSTEM_CRON",
                idempotencyKey:
                  opts.idempotencyKey ?? globalThis.crypto.randomUUID(),
                orgPayoutAccountId: payoutAccount.id,
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
                acc.platformFeePaise += e.platformFeePaise;
                acc.orgShare += e.orgSharePaise;
                acc.refunds += e.refundedAmountPaise;
                return acc;
              },
              { gross: 0, platformFeePaise: 0, orgShare: 0, refunds: 0 },
            );
            const netPayout = totals.orgShare - totals.refunds;
            if (netPayout <= 0) {
              throw new PayoutValidationError(
                `Net payout would be ${netPayout} paise — refunds exceed earnings. Reconcile first.`,
                409,
              );
            }

            const orgForCompliance = await tx.organization.findUnique({
              where: { id: orgId },
              select: {
                taxInfo: { select: { panEncrypted: true } },
                msmeInfo: {
                  select: {
                    msmeStatus: true,
                    msmeWrittenAgreementOnFile: true,
                  },
                },
              },
            });
            const resolvedRate = await resolveEffectiveTdsRate(
              tx,
              null,
              new Date(),
            );
            const tds = computeResidentPayoutTds(
              netPayout,
              !!orgForCompliance?.taxInfo?.panEncrypted,
              resolvedRate,
            );
            const recoveredPaise = await recoverClawbackOnPayout(tx, {
              payee: { rail: "ORG", organizationId: orgId },
              payoutId: created.id,
              recoverablePaise: recoverablePaise(
                netPayout - tds.tdsAmountPaise,
                PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
                true,
              ),
            });
            const amountAfterTds =
              netPayout - tds.tdsAmountPaise - recoveredPaise;
            const tdsRateBps = tds.rateAppliedBps;
            const mustPayByDate = resolvePayoutMsmeDeadline(
              orgForCompliance?.msmeInfo?.msmeStatus,
              orgForCompliance?.msmeInfo?.msmeWrittenAgreementOnFile,
            );

            await tx.organizationPayout.update({
              where: { id: created.id },
              data: {
                amountPaise: amountAfterTds,
                currency: first.currency,
                grossRevenuePaise: totals.gross,
                platformFeePaise: totals.platformFeePaise,
                refundsPaise: totals.refunds,
                netPayoutPaise: netPayout,
                tdsSectionApplied: tds.tdsSection,
                tdsAmountPaise: tds.tdsAmountPaise,
                tdsRateAppliedBps: tdsRateBps,
                tdsFinancialYear: getIndianFinancialYear(),
                dtaaRateApplied:
                  tds.dtaaRateApplied !== null
                    ? new Prisma.Decimal(tds.dtaaRateApplied)
                    : null,
                mustPayByDate,
              },
            });

            // Stage claimed earnings as BATCHED; PAID transition occurs only at markOrgPayoutCompleted.
            await tx.organizationEarnings.updateMany({
              where: { orgPayoutId: created.id, status: "READY" },
              data: { status: "BATCHED" },
            });

            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: opts.actorMembershipId ?? null,
                category: "PAYOUT",
                action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
                description: `Payout batch created: ${readyEarnings.length} ${readyEarnings.length === 1 ? "earning" : "earnings"}, ${formatNotificationMoney(amountAfterTds, first.currency)} after ${formatNotificationMoney(tds.tdsAmountPaise, first.currency)} TDS under ${tdsSectionLabel(tds.tdsSection)}`,
                details: {
                  payoutId: created.id,
                  earningsCount: readyEarnings.length,
                  netPayoutPaise: netPayout,
                  amountAfterTdsPaise: amountAfterTds,
                  grossPaise: totals.gross,
                  platformFeePaise: totals.platformFeePaise,
                  refundsPaise: totals.refunds,
                  tdsSection: tds.tdsSection,
                  tdsRate: tds.tdsRate,
                  tdsRateBps,
                  tdsAmountPaise: tds.tdsAmountPaise,
                  clawbackRecoveredPaise: recoveredPaise,
                  tdsFallback: tds.fallbackApplied,
                  tdsReason: tds.reason,
                  idempotencyKey: created.idempotencyKey,
                },
              },
            });

            return {
              payoutId: created.id,
              amountPaise: amountAfterTds,
              earningsCount: readyEarnings.length,
              periodStart,
              periodEnd,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 25_000,
          },
        ),
      1,
    );

    return result;
  } catch (err) {
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
        reportSentryError(err, { subsystem: "payments", expected: true });
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
    // Callers report: the route per request, the scheduled batch once per run.
    throw err;
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * A Familiarise admin's co-approval of a payout the org has already approved:
 * PENDING with `platformApprovalRequiredAt` → APPROVED. The approver may be
 * neither the payout's creator nor the org member who approved it.
 */
export async function approveOrgPayout(
  payoutId: string,
  platformUserId: string,
  db: PrismaLike = prisma,
): Promise<{ organizationId: string; amountPaise: number }> {
  const existing = await db.organizationPayout.findUnique({
    where: { id: payoutId },
    select: {
      status: true,
      createdBy: true,
      orgApprovedBy: true,
      organizationId: true,
      amountPaise: true,
      platformApprovalRequiredAt: true,
    },
  });
  if (!existing) {
    throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
  }
  if (existing.status !== "PENDING") {
    throw new PayoutValidationError(
      `Payout cannot be approved from status: ${existing.status}`,
      409,
    );
  }
  if (!existing.platformApprovalRequiredAt) {
    throw new PayoutValidationError(
      "The organisation has not approved this payout yet, or it does not need a platform approval.",
      409,
    );
  }
  if (
    platformUserId === existing.createdBy ||
    platformUserId === existing.orgApprovedBy
  ) {
    throw new PayoutMakerCheckerError(
      "Maker-checker violation: whoever created or approved this payout for the organisation cannot also co-approve it.",
    );
  }

  const approved = await db.organizationPayout.updateMany({
    where: {
      id: payoutId,
      status: { in: PAYOUT_ALLOWED_FROM.APPROVED },
      platformApprovalRequiredAt: { not: null },
    },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedBy: platformUserId,
    },
  });
  if (approved.count === 0) {
    throw new PayoutValidationError(
      "Another decision on this payout landed first — reload the list.",
      409,
    );
  }
  return {
    organizationId: existing.organizationId,
    amountPaise: existing.amountPaise,
  };
}

async function readOrgPayoutCurrentStatus(
  tx: Tx,
  payoutId: string,
): Promise<PayoutStatus> {
  const current = await tx.organizationPayout.findUnique({
    where: { id: payoutId },
    select: { status: true },
  });
  if (!current) {
    throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
  }
  return current.status;
}

async function checkOrgPayoutDisputeOrRefundBlock(
  tx: Tx,
  payoutId: string,
): Promise<PayoutStatus | null> {
  const disputedOrgEarning = await tx.organizationEarnings.findFirst({
    where: {
      orgPayoutId: payoutId,
      payment: DISPUTE_GATED_PAYMENT_WHERE,
    },
    select: { id: true },
  });
  if (disputedOrgEarning) {
    console.warn(
      `[OrgPayoutService] payout ${payoutId} blocked — an earning's payment has a live dispute`,
    );
    return readOrgPayoutCurrentStatus(tx, payoutId);
  }

  const uncascadedRefundEarning = await tx.organizationEarnings.findFirst({
    where: { orgPayoutId: payoutId, payment: REFUND_GATED_PAYMENT_WHERE },
    select: { id: true },
  });
  if (uncascadedRefundEarning) {
    console.warn(
      `[OrgPayoutService] payout ${payoutId} blocked — an earning's payment has an in-flight or uncascaded refund`,
    );
    return readOrgPayoutCurrentStatus(tx, payoutId);
  }
  return null;
}

async function checkOrgPayoutShortfallBeforeDisbursement(
  tx: Tx,
  payout: {
    id: string;
    organizationId: string;
    amountPaise: number;
    netPayoutPaise: number | null;
  },
): Promise<boolean> {
  if (typeof tx.organizationEarnings.aggregate !== "function") {
    return false;
  }
  const owedAgg = await tx.organizationEarnings.aggregate({
    where: { orgPayoutId: payout.id },
    _sum: { orgSharePaise: true, refundedAmountPaise: true },
  });
  if (!owedAgg?._sum) {
    return false;
  }
  const owedPaise =
    sumPaise(owedAgg._sum.orgSharePaise) -
    sumPaise(owedAgg._sum.refundedAmountPaise);
  const expectedNet = payout.netPayoutPaise ?? payout.amountPaise;
  if (owedPaise >= expectedNet) {
    return false;
  }
  const shortfallReason = `SHORTFALL_BEFORE_DISBURSEMENT: earnings owe ${owedPaise}p < batched ${expectedNet}p`;
  await tx.organizationPayout.updateMany({
    where: { id: payout.id, status: "PROCESSING" },
    data: {
      status: "FAILED",
      failureReason: shortfallReason.slice(0, 500),
      failedAt: new Date(),
    },
  });
  await tx.organizationEarnings.updateMany({
    where: { orgPayoutId: payout.id, status: "BATCHED" },
    data: { status: "READY", orgPayoutId: null },
  });
  await releaseClawbackRecovery(tx, payout.id);
  await tx.orgAuditLog.create({
    data: {
      organizationId: payout.organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
      description:
        "Payout failed before disbursement: refunds after batching left it short",
      details: {
        payoutId: payout.id,
        owedPaise,
        expectedNetPaise: expectedNet,
        reason: shortfallReason,
      },
    },
  });
  reportSentryMessage("org-payout-batch-earnings-shortfall", {
    subsystem: "payments",
    level: "error",
    extra: { payoutId: payout.id, owedPaise, expectedNetPaise: expectedNet },
  });
  return true;
}

export async function processOrgPayout(payoutId: string): Promise<{
  status: PayoutStatus;
  submittedToGateway: boolean;
  claimed: boolean;
}> {
  const liveEnabled = process.env.ENABLE_LIVE_PAYOUTS === "true";
  if (liveEnabled) {
    const held = await holdOrgPayoutOnShortBalance(payoutId);
    if (held) return held;
  }

  return withSerializableRetry(
    () =>
      prisma.$transaction(
        async (tx) => {
          if (!liveEnabled) {
            const status = await readOrgPayoutCurrentStatus(tx, payoutId);
            return {
              status,
              submittedToGateway: false,
              claimed: false,
            };
          }

          const blockedStatus = await checkOrgPayoutDisputeOrRefundBlock(
            tx,
            payoutId,
          );
          if (blockedStatus) {
            return {
              status: blockedStatus,
              submittedToGateway: false,
              claimed: false,
            };
          }

          // A platform hold parks the payout; release lets the next pass claim it.
          const claim = await tx.organizationPayout.updateMany({
            where: {
              id: payoutId,
              status: { in: PAYOUT_ALLOWED_FROM.PROCESSING },
              platformHeldAt: null,
            },
            data: { status: "PROCESSING" },
          });
          if (claim.count === 0) {
            const status = await readOrgPayoutCurrentStatus(tx, payoutId);
            console.log(
              `[OrgPayoutService] processOrgPayout no-op: payout ${payoutId} status=${status}`,
            );
            return {
              status,
              submittedToGateway: false,
              claimed: false,
            };
          }

          const payout = await tx.organizationPayout.findUniqueOrThrow({
            where: { id: payoutId },
            select: {
              id: true,
              organizationId: true,
              amountPaise: true,
              netPayoutPaise: true,
              currency: true,
            },
          });

          if (await checkOrgPayoutShortfallBeforeDisbursement(tx, payout)) {
            return {
              status: "FAILED" as PayoutStatus,
              submittedToGateway: false,
              claimed: true,
            };
          }

          await tx.orgAuditLog.create({
            data: {
              organizationId: payout.organizationId,
              actorMembershipId: null,
              category: "PAYOUT",
              action: AUDIT_ACTIONS.PAYOUT.PAYOUT_PROCESSED,
              description: `Payout of ${formatNotificationMoney(payout.amountPaise, payout.currency)} is processing`,
              details: {
                payoutId,
                amountPaise: payout.amountPaise,
                currency: payout.currency,
                liveSubmissionEnabled: liveEnabled,
              },
            },
          });

          return {
            status: "PROCESSING" as const,
            submittedToGateway: false,
            claimed: true,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 25_000,
        },
      ),
    1,
  ).then(async (result) => {
    if (!liveEnabled || !result.claimed || result.status !== "PROCESSING") {
      return {
        status: result.status,
        submittedToGateway: result.submittedToGateway,
        claimed: result.claimed,
      };
    }

    try {
      await submitOrgPayoutToGateway(payoutId);
      return {
        status: "PROCESSING" as const,
        submittedToGateway: true,
        claimed: true,
      };
    } catch (err) {
      if (err instanceof OrgPayoutAccountChangedError) {
        await markOrgPayoutFailed(
          payoutId,
          "PAYOUT_ACCOUNT_CHANGED: the payout account changed after this payout was created; its earnings return to the next batch, which needs a fresh approval",
        );
        return {
          status: "FAILED" as PayoutStatus,
          submittedToGateway: false,
          claimed: true,
        };
      }
      const cls = classifyGatewaySubmissionError(err);
      if (cls === "PERMANENT_4XX") {
        reportSentryError(err, { subsystem: "payments", expected: true });
        await markPayoutFailedFromSubmission(
          payoutId,
          err instanceof Error ? err.message : String(err),
        );
        return {
          status: "FAILED" as PayoutStatus,
          submittedToGateway: true,
          claimed: true,
        };
      }
      reportSentryError(err, { subsystem: "payments" });
      throw err;
    }
  });
}

/** The balance is read before the claim, so a short balance leaves the payout APPROVED, never PROCESSING with nothing sent. */
async function holdOrgPayoutOnShortBalance(payoutId: string): Promise<{
  status: PayoutStatus;
  submittedToGateway: false;
  claimed: false;
} | null> {
  const row = await prisma.organizationPayout.findUnique({
    where: { id: payoutId },
    select: { status: true, amountPaise: true, platformHeldAt: true },
  });
  // A row the claim would refuse needs no balance read; the claim decides it.
  if (
    !row ||
    row.platformHeldAt ||
    !PAYOUT_ALLOWED_FROM.PROCESSING.includes(row.status)
  ) {
    return null;
  }
  const preflight = await assertPayoutBalance(row.amountPaise);
  if (preflight.ok) return null;
  console.warn(
    `[OrgPayoutService] Holding payout ${payoutId} — ${preflight.reason}`,
  );
  return { status: row.status, submittedToGateway: false, claimed: false };
}

async function submitOrgPayoutToGateway(payoutId: string): Promise<void> {
  const payout = await prisma.organizationPayout.findUniqueOrThrow({
    where: { id: payoutId },
    select: {
      id: true,
      organizationId: true,
      amountPaise: true,
      currency: true,
      paymentGateway: true,
      payoutReference: true,
      createdAt: true,
      orgPayoutAccount: {
        select: {
          status: true,
          razorpayFundAccountId: true,
          payoutsAllowedAfter: true,
          payoutsFrozenAt: true,
        },
      },
    },
  });

  if (payout.paymentGateway !== "RAZORPAY") {
    throw new PayoutValidationError(
      `Payout ${payoutId}: gateway ${payout.paymentGateway} has no payout rail; only RazorpayX disburses`,
      400,
    );
  }

  // Sent to the account snapshotted at mint; a pre-snapshot payout falls back
  // to the org's current account, which must also be out of cooling-off.
  const fallback = payout.orgPayoutAccount
    ? null
    : await prisma.organizationPayoutAccount.findUnique({
        where: { organizationId: payout.organizationId },
        select: {
          status: true,
          razorpayFundAccountId: true,
          payoutsAllowedAfter: true,
          payoutsFrozenAt: true,
        },
      });
  if (fallback && payoutAccountHold(fallback)) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: ${payoutAccountHold(fallback)} on the organisation's current payout account — refusing to submit`,
      409,
    );
  }
  const account = payout.orgPayoutAccount ?? fallback;
  const fundAccountId = account?.razorpayFundAccountId ?? null;
  if (!fundAccountId) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: its snapshotted payout account is missing or has no razorpayFundAccountId`,
      400,
    );
  }
  if (account?.status !== "VERIFIED" || account.payoutsFrozenAt) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: snapshotted payout account is ${account?.payoutsFrozenAt ? "frozen" : (account?.status ?? "missing")} — refusing to submit`,
      409,
    );
  }
  // The org account row is edited in place, so a destination changed after mint is a different destination.
  const changedAt = payout.orgPayoutAccount
    ? payoutAccountChangedAt(account)
    : null;
  if (changedAt !== null && changedAt > payout.createdAt.getTime()) {
    throw new OrgPayoutAccountChangedError(payoutId);
  }

  const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
  const sdk = getRazorpayPayoutsService();
  const idempotencyKey = sdk.generateIdempotencyKey(payoutId);
  const mode = sdk.determinePayoutMode(payout.amountPaise, "bank_account");

  const response = await sdk.createPayout({
    fundAccountId,
    amount: payout.amountPaise,
    currency: payout.currency,
    mode,
    purpose: "payout",
    referenceId: payoutId,
    narration: "Familiarise org payout",
    queueIfLowBalance: true,
    idempotencyKey,
  });

  await prisma.organizationPayout.update({
    where: { id: payoutId },
    data: {
      gatewayPayoutId: response.id,
      gatewayResponseRaw: response as unknown as Prisma.JsonObject,
    },
  });
}

async function markPayoutFailedFromSubmission(
  payoutId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) return;

    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "BATCHED" },
      data: { status: "READY", orgPayoutId: null },
    });
    await releaseClawbackRecovery(tx, payoutId);

    await tx.orgAuditLog.create({
      data: {
        organizationId: (
          await tx.organizationPayout.findUniqueOrThrow({
            where: { id: payoutId },
            select: { organizationId: true },
          })
        ).organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description: "Payout submission rejected by the payment provider",
        details: { payoutId, reason: reason.slice(0, 500) },
      },
    });
  });
}

/** Either approver who also triggered this run may not disburse, as on the consultant rail. */
function isOrgDisbursementBlocked(
  p: { id: string; approvedBy: string | null; orgApprovedBy: string | null },
  triggeredByUserId: string | undefined,
): Promise<boolean> {
  const approver =
    p.approvedBy === triggeredByUserId ? p.approvedBy : p.orgApprovedBy;
  return isMakerCheckerDisbursementBlocked(p.id, approver, triggeredByUserId);
}

export interface OrgProcessingResult {
  scanned: number;
  advanced: number;
  errors: string[];
}

/** Org payouts the processing pass may claim; a platform hold parks the row. */
function pendingOrgPayoutWhere(): Prisma.OrganizationPayoutWhereInput {
  return {
    status: { in: PAYOUT_ALLOWED_FROM.PROCESSING },
    platformHeldAt: null,
  };
}

/** PROCESSING org payouts untouched long enough for the gateway re-drive. */
function staleProcessingOrgPayoutWhere(
  staleBefore: Date,
): Prisma.OrganizationPayoutWhereInput {
  return { status: "PROCESSING", updatedAt: { lt: staleBefore } };
}

/** `limit` caps the claims plus failures per pass; an unclaimable row does not count. */
export async function processPendingOrgPayouts(
  opts: { limit?: number; triggeredByUserId?: string } = {},
): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };

  const pending = await prisma.organizationPayout.findMany({
    where: pendingOrgPayoutWhere(),
    select: { id: true, approvedBy: true, orgApprovedBy: true },
    orderBy: { createdAt: "asc" },
  });
  result.scanned = pending.length;

  for (const p of pending) {
    if (
      opts.limit !== undefined &&
      result.advanced + result.errors.length >= opts.limit
    ) {
      break;
    }
    if (await isOrgDisbursementBlocked(p, opts.triggeredByUserId)) continue;
    try {
      const out = await processOrgPayout(p.id);
      if (out.claimed) {
        result.advanced++;
      }
    } catch (err) {
      reportSentryError(err, { subsystem: "payments" });
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`OrgPayout ${p.id}: ${message}`);
    }
  }

  const redrive = await redriveStaleProcessingOrgPayouts(opts.limit);
  result.scanned += redrive.scanned;
  result.advanced += redrive.advanced;
  result.errors.push(...redrive.errors);

  return result;
}

const ORG_PROCESSING_REDRIVE_AFTER_MS = 60 * 60 * 1000;

async function redriveSingleOrgPayoutRow(
  p: { id: string; gatewayPayoutId: string | null },
  result: OrgProcessingResult,
): Promise<void> {
  const { findRazorpayPayoutByReference } =
    await import("./payout-gateway-lookup");
  const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
  const sdk = getRazorpayPayoutsService();
  let gatewayPayoutId = p.gatewayPayoutId;

  if (!gatewayPayoutId) {
    const lookup = await findRazorpayPayoutByReference(p.id);
    if (lookup.kind === "found") {
      gatewayPayoutId = lookup.providerPayoutId;
      await prisma.organizationPayout.update({
        where: { id: p.id },
        data: { gatewayPayoutId },
      });
    } else if (lookup.kind === "none") {
      // A re-drive never sends: re-armed APPROVED, the next processOrgPayout re-runs every first-send gate.
      const reset = await prisma.organizationPayout.updateMany({
        where: { id: p.id, status: "PROCESSING", gatewayPayoutId: null },
        data: { status: "APPROVED" },
      });
      if (reset.count > 0) result.advanced++;
      return;
    } else {
      result.errors.push(
        `OrgPayout ${p.id}: reference lookup ${lookup.kind}: ${lookup.detail}`,
      );
      return;
    }
  }

  const remote = await sdk.fetchPayout(gatewayPayoutId);
  const moved = await applyOrgGatewayStatus(p.id, {
    status: remote.status,
    utr: remote.utr,
    failureReason:
      remote.failure_reason ??
      remote.status_details?.description ??
      remote.status_details?.reason,
  });
  if (moved) result.advanced++;
}

export interface OrgGatewayStatus {
  status: string;
  utr?: string | null;
  failureReason?: string | null;
}

/** Settles a PROCESSING org payout from the status RazorpayX reports; true when the row moved. */
export async function applyOrgGatewayStatus(
  payoutId: string,
  remote: OrgGatewayStatus,
): Promise<boolean> {
  switch (remote.status) {
    case "processed":
      if (remote.utr) {
        await prisma.organizationPayout.updateMany({
          where: { id: payoutId, gatewayUtr: null },
          data: { gatewayUtr: remote.utr },
        });
      }
      await markOrgPayoutCompleted(payoutId);
      return true;
    case "failed":
      await markOrgPayoutFailed(
        payoutId,
        remote.failureReason || "Gateway reports the payout failed",
      );
      return true;
    case "cancelled":
    case "rejected":
      await markOrgPayoutFailed(
        payoutId,
        `Gateway reports the payout ${remote.status}`,
      );
      return true;
    case "reversed":
      await markOrgPayoutReversed(
        payoutId,
        "Gateway reports the payout reversed",
      );
      return true;
    default:
      return false;
  }
}

async function redriveStaleProcessingOrgPayouts(
  limit = 100,
): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };
  const staleBefore = new Date(Date.now() - ORG_PROCESSING_REDRIVE_AFTER_MS);
  const stale = await prisma.organizationPayout.findMany({
    where: staleProcessingOrgPayoutWhere(staleBefore),
    select: { id: true, gatewayPayoutId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  result.scanned = stale.length;

  await Promise.all(
    stale.map(async (p) => {
      try {
        await redriveSingleOrgPayoutRow(p, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          classifyGatewaySubmissionError(err) === "PERMANENT_4XX" ||
          err instanceof PayoutValidationError
        ) {
          await markOrgPayoutFailed(p.id, `redrive rejected: ${message}`);
          result.advanced++;
          return;
        }
        reportSentryError(err, { subsystem: "payments" });
        result.errors.push(`OrgPayout redrive ${p.id}: ${message}`);
      }
    }),
  );

  return result;
}

type OrgPayoutCompletionShortfall = {
  organizationId: string;
  shortfallPaise: number;
  owedPaise: number;
  netPayoutPaise: number;
};

/** Read-only: what the batch's earnings owe less than the payout sent, or null. */
async function detectOrgPayoutCompletionShortfall(
  tx: Tx,
  payout: {
    id: string;
    organizationId: string;
    netPayoutPaise: number;
  },
): Promise<OrgPayoutCompletionShortfall | null> {
  if (typeof tx.organizationEarnings?.findMany !== "function") {
    return null;
  }
  const batchEarnings = await tx.organizationEarnings.findMany({
    where: { orgPayoutId: payout.id },
    select: { orgSharePaise: true, refundedAmountPaise: true },
  });
  if (!Array.isArray(batchEarnings) || batchEarnings.length === 0) {
    return null;
  }
  const owedPaise = batchEarnings.reduce(
    (sum, e) => sum + (e.orgSharePaise - (e.refundedAmountPaise ?? 0)),
    0,
  );
  if (owedPaise >= payout.netPayoutPaise) {
    return null;
  }
  return {
    organizationId: payout.organizationId,
    shortfallPaise: payout.netPayoutPaise - owedPaise,
    owedPaise,
    netPayoutPaise: payout.netPayoutPaise,
  };
}

/** Claws the shortfall back net of its TDS; runs after the completion TDSRecord exists. */
async function accrueOrgPayoutCompletionShortfall(
  tx: Tx,
  payoutId: string,
  shortfall: OrgPayoutCompletionShortfall,
): Promise<void> {
  const clawbackPaise = await orgClawbackNetOfTds(tx, {
    orgPayoutId: payoutId,
    organizationId: shortfall.organizationId,
    grossPaise: shortfall.shortfallPaise,
    netPayoutPaise: shortfall.netPayoutPaise,
  });
  if (typeof tx.organizationPayout?.update === "function") {
    await tx.organizationPayout.update({
      where: { id: payoutId },
      data: {
        clawbackAmountPaise: { increment: clawbackPaise },
      },
    });
  } else {
    await tx.organizationPayout.updateMany({
      where: { id: payoutId },
      data: {
        clawbackAmountPaise: { increment: clawbackPaise },
      },
    });
  }
  await postPayoutClawback(tx, {
    refundId: `shortfall:${payoutId}`,
    payoutId,
    orgEarningsId: null,
    amountPaise: clawbackPaise,
    organizationId: shortfall.organizationId,
  });
}

async function recordOrgPayoutCompletionTdsInTx(
  tx: Tx,
  payout: {
    id: string;
    organizationId: string;
    netPayoutPaise: number;
    tdsSectionApplied: string | null;
  },
  orgTds: number,
  orgTdsRateBps: number,
  shortfallPaise = 0,
): Promise<void> {
  await tx.tDSRecord.deleteMany({
    where: { orgPayoutId: payout.id, isReversal: false },
  });

  const { financialYear, quarter, start, end } = resolveCompletionTdsWindow();
  const priorCompleted = await tx.organizationPayout.aggregate({
    where: {
      organizationId: payout.organizationId,
      status: "COMPLETED",
      processedAt: { gte: start, lt: end },
      id: { not: payout.id },
    },
    _sum: { netPayoutPaise: true },
  });
  const cumulativeAmountCredited = Math.max(
    0,
    sumPaise(priorCompleted._sum.netPayoutPaise) +
      payout.netPayoutPaise -
      shortfallPaise,
  );

  await recordOrgTDSDeduction({
    organizationId: payout.organizationId,
    financialYear,
    tdsDeducted: orgTds,
    tdsRateBps: orgTdsRateBps,
    cumulativeAmountCredited,
    orgPayoutId: payout.id,
    quarter,
    tdsSection: payout.tdsSectionApplied ?? undefined,
    db: tx,
  });
}

async function reportOrgPayoutCompletionFollowups(
  payoutId: string,
  result: {
    shortfall: OrgPayoutCompletionShortfall | null;
    missingTdsRate: { organizationId: string; tdsAmountPaise: number } | null;
    notifyStaged: StagedTrigger[];
    notifyEmails: StagedRecipientEmail[];
    notify: {
      organizationId: string;
      orgName: string;
      amountPaise: number;
      netPayoutPaise: number;
      tdsAmountPaise: number;
      currency: string;
    } | null;
  },
): Promise<void> {
  if (result.shortfall && typeof recordSystemEventSafe === "function") {
    await recordSystemEventSafe({
      organizationId: result.shortfall.organizationId,
      category: "PAYOUT",
      severity: "WARN",
      message: `Org payout ${payoutId} completed with post-processing refund shortfall of ${result.shortfall.shortfallPaise} paise; recorded in clawbackAmountPaise`,
      context: {
        action: "ORG_PAYOUT_COMPLETION_EARNINGS_SHORTFALL",
        orgPayoutId: payoutId,
        organizationId: result.shortfall.organizationId,
        netPayoutPaise: result.shortfall.netPayoutPaise,
        owedPaise: result.shortfall.owedPaise,
        shortfallPaise: result.shortfall.shortfallPaise,
      },
    });
  }

  if (result.missingTdsRate) {
    const summary =
      "org payout completed with withheld TDS but no applied rate; TDSRecord not written";
    const context = {
      orgPayoutId: payoutId,
      organizationId: result.missingTdsRate.organizationId,
      tdsAmountPaise: result.missingTdsRate.tdsAmountPaise,
    };
    await recordSystemErrorSafe({
      organizationId: result.missingTdsRate.organizationId,
      category: "PAYOUT",
      summary: `ORG_PAYOUT_TDS_RATE_MISSING — ${summary}`,
      err: new Error(summary),
      context,
    });
    reportSentryMessage(summary, {
      subsystem: "payments",
      op: "markOrgPayoutCompleted",
      level: "warning",
      extra: context,
    });
  }

  if (result.notify) {
    const dashboardUrl = `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`;
    await Promise.allSettled([
      ...(result.notifyStaged.length > 0
        ? [attemptStagedBells(result.notifyStaged, "COMPLETED")]
        : [
            notifyOrgPayoutCompleted(result.notify.organizationId, {
              orgName: result.notify.orgName,
              payoutId,
              amountPaise: result.notify.amountPaise,
              netPayoutPaise: result.notify.netPayoutPaise,
              tdsAmountPaise: result.notify.tdsAmountPaise,
              currency: result.notify.currency,
              dashboardUrl,
            }),
          ]),
      attemptStagedEmails(
        result.notifyEmails,
        MONEY_EMAIL_TYPES.PAYOUT_STATUS,
        EMAIL_BUDGET_MS.WEBHOOK,
      ),
    ]);
  }
}

async function stageOrgPayoutEmailsInTx(
  tx: Tx,
  params: {
    organizationId: string;
    orgName: string;
    payoutId: string;
    status: "COMPLETED" | "FAILED" | "REVERSED";
    amountPaise: number;
    currency: string;
    tdsAmountPaise: number;
    reason?: string | null;
  },
): Promise<StagedRecipientEmail[]> {
  if (!tx.membership || !tx.user || !tx.failedEmail) {
    return [];
  }
  const members = await tx.membership.findMany({
    where: {
      organizationId: params.organizationId,
      status: "ACTIVE",
      role: { in: VISIBILITY_ROLES },
    },
    select: { userId: true },
  });
  if (members.length === 0) return [];
  const withheldText =
    params.tdsAmountPaise > 0
      ? `${formatNotificationMoney(params.tdsAmountPaise, params.currency)} TDS withheld`
      : null;
  return stagePayoutStatusEmail(tx, {
    recipientUserIds: members.map((m) => m.userId),
    payoutId: params.payoutId,
    status: params.status,
    amountPaise: params.amountPaise,
    currency: params.currency,
    orgName: params.orgName,
    reason: params.reason,
    withheldText,
    dashboardUrl: `${getAppUrl()}/dashboard/organization/${params.organizationId}/payouts`,
  });
}

export async function markOrgPayoutCompleted(payoutId: string): Promise<{
  wasNoOp: boolean;
  status: PayoutStatus;
}> {
  const completion = withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const settledAt = new Date();
        const claim = await tx.organizationPayout.updateMany({
          where: { id: payoutId, status: "PROCESSING" },
          data: { status: "COMPLETED", processedAt: settledAt },
        });
        if (claim.count === 0) {
          const status = await readOrgPayoutCurrentStatus(tx, payoutId);
          console.log(
            `[OrgPayoutService] markOrgPayoutCompleted no-op: payout ${payoutId} status=${status}`,
          );
          return {
            wasNoOp: true,
            status,
            notifyStaged: [] as StagedTrigger[],
            notifyEmails: [] as StagedRecipientEmail[],
            notify: null,
            missingTdsRate: null,
            shortfall: null,
          };
        }

        const payout = await tx.organizationPayout.findUniqueOrThrow({
          where: { id: payoutId },
          select: {
            id: true,
            organizationId: true,
            netPayoutPaise: true,
            amountPaise: true,
            tdsAmountPaise: true,
            tdsRateAppliedBps: true,
            tdsSectionApplied: true,
            currency: true,
            gatewayUtr: true,
            organization: { select: { name: true } },
          },
        });

        await tx.organizationEarnings.updateMany({
          where: { orgPayoutId: payoutId, status: "BATCHED" },
          data: { status: "PAID" },
        });

        const completionShortfall = await detectOrgPayoutCompletionShortfall(
          tx,
          payout,
        );

        await tx.orgAuditLog.create({
          data: {
            organizationId: payout.organizationId,
            actorMembershipId: null,
            category: "PAYOUT",
            action: AUDIT_ACTIONS.PAYOUT.PAYOUT_COMPLETED,
            description: `Payout of ${formatNotificationMoney(payout.amountPaise, payout.currency)} completed`,
            details: {
              payoutId,
              netPayoutPaise: payout.netPayoutPaise,
              currency: payout.currency,
            },
          },
        });

        const orgTds = payout.tdsAmountPaise ?? 0;
        const recoveredPaise = await clawbackRecoveredPaise(tx, payoutId);
        assertOrgPayoutWithholdingIdentity(payout, recoveredPaise);
        if (payout.netPayoutPaise - recoveredPaise > 0) {
          await postLedgerTxn(tx, {
            idempotencyKey: `orgpayout:${payoutId}`,
            kind: "ORG_PAYOUT",
            payoutId,
            postings: buildPayoutCompletionPostings({
              payableAccount: {
                kind: "ORG_PAYABLE",
                organizationId: payout.organizationId,
              },
              grossPayablePaise: payout.netPayoutPaise - recoveredPaise,
              netCashPaise: payout.amountPaise,
              tdsPaise: orgTds,
            }),
          });
        }

        const orgTdsRateBps = payout.tdsRateAppliedBps;
        const hasOrgTdsRate = orgTdsRateBps !== null && orgTdsRateBps > 0;
        if (orgTds > 0 && hasOrgTdsRate) {
          await recordOrgPayoutCompletionTdsInTx(
            tx,
            payout,
            orgTds,
            orgTdsRateBps,
            completionShortfall?.shortfallPaise ?? 0,
          );
        }
        if (completionShortfall) {
          await accrueOrgPayoutCompletionShortfall(
            tx,
            payoutId,
            completionShortfall,
          );
        }

        await dispatchWebhookEvent({
          prisma: tx,
          organizationId: payout.organizationId,
          eventType: "payout.completed",
          payload: {
            payoutId: payout.id,
            totalPaise: Number(payout.netPayoutPaise),
            currency: payout.currency,
            payoutReference: payout.gatewayUtr ?? null,
            settledAt: settledAt.toISOString(),
          },
        });

        const canStageBells =
          typeof tx.notificationOutbox?.upsert === "function" &&
          typeof tx.membership?.findMany === "function";
        const notifyStaged = canStageBells
          ? await notifyOrgPayoutCompleted(
              payout.organizationId,
              {
                orgName: payout.organization.name,
                payoutId,
                amountPaise: payout.amountPaise,
                netPayoutPaise: payout.netPayoutPaise,
                tdsAmountPaise: orgTds,
                currency: payout.currency,
                dashboardUrl: `${getAppUrl()}/dashboard/organization/${payout.organizationId}/payouts`,
              },
              { tx, entityRef: `orgPayout:${payoutId}` },
            )
          : [];
        const notifyEmails = await stageOrgPayoutEmailsInTx(tx, {
          organizationId: payout.organizationId,
          orgName: payout.organization.name,
          payoutId,
          status: "COMPLETED",
          amountPaise: payout.amountPaise,
          currency: payout.currency,
          tdsAmountPaise: orgTds,
        });

        return {
          wasNoOp: false,
          status: "COMPLETED" as PayoutStatus,
          notifyStaged,
          notifyEmails,
          notify: {
            organizationId: payout.organizationId,
            orgName: payout.organization.name,
            amountPaise: payout.amountPaise,
            netPayoutPaise: payout.netPayoutPaise,
            tdsAmountPaise: orgTds,
            currency: payout.currency,
          },
          missingTdsRate:
            orgTds > 0 && !hasOrgTdsRate
              ? {
                  organizationId: payout.organizationId,
                  tdsAmountPaise: orgTds,
                }
              : null,
          shortfall: completionShortfall,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  const result = await completion.catch(async (err: unknown) => {
    if (err instanceof OrgPayoutWithholdingMismatchError) {
      await reportOrgPayoutWithholdingMismatch(err, "markOrgPayoutCompleted");
    }
    throw err;
  });

  await reportOrgPayoutCompletionFollowups(payoutId, result);

  return { wasNoOp: result.wasNoOp, status: result.status };
}

async function emailOrgPayoutFailed(
  payoutId: string,
  kind: "FAILED" | "REVERSED",
  reason: string,
  notify: {
    organizationId: string;
    orgName: string;
    amountPaise: number | bigint;
    tdsAmountPaise: number | bigint | null;
    currency: string;
  },
): Promise<void> {
  try {
    const { rosterForOrg, VISIBILITY_ROLES } =
      await import("@/lib/novu/org-workflows");
    const { formatNotificationMoney } = await import("@/lib/novu/humanize");
    const roster = await rosterForOrg(notify.organizationId, VISIBILITY_ROLES);
    const withheldPaise = Number(notify.tdsAmountPaise ?? 0);
    await sendOrgPayoutFailedEmail({
      recipientUserIds: roster,
      kind,
      orgName: notify.orgName,
      payoutId,
      amountPaise: notify.amountPaise,
      currency: notify.currency,
      reason: reason.slice(0, 200),
      withheldText:
        withheldPaise > 0
          ? formatNotificationMoney(withheldPaise, notify.currency)
          : undefined,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${notify.organizationId}/payouts`,
    });
  } catch (e) {
    reportSentryError(e, { subsystem: "payments" });
    console.error(`[org-payout] ${kind} email failed:`, e);
  }
}

/**
 * Returns an unpaid organisation payout's earnings to READY, drops its TDS rows,
 * records the outcome and stages the notices, inside the caller's transaction.
 */
async function settleUnpaidOrgPayoutTx(
  tx: Tx,
  {
    payoutId,
    kind,
    reason,
    reversedFrom,
  }: {
    payoutId: string;
    kind: "FAILED" | "REVERSED";
    reason: string;
    reversedFrom?: "COMPLETED" | "PROCESSING";
  },
) {
  await tx.organizationEarnings.updateMany({
    where: { orgPayoutId: payoutId, status: "BATCHED" },
    data: { status: "READY", orgPayoutId: null },
  });

  await tx.tDSRecord.deleteMany({
    where: { orgPayoutId: payoutId, isReversal: false },
  });
  await releaseClawbackRecovery(tx, payoutId);

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

  await recordOrgPayoutFailureOutcome(tx, {
    organizationId: payout.organizationId,
    payoutId,
    kind,
    reversedFrom,
    reason,
  });

  const notifyStaged = await notifyOrgPayoutFailed(
    payout.organizationId,
    {
      orgName: payout.organization.name,
      payoutId,
      amountPaise: payout.netPayoutPaise,
      netPayoutPaise: payout.netPayoutPaise,
      tdsAmountPaise: 0,
      currency: payout.currency,
      reason: reason.slice(0, 200),
      kind,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${payout.organizationId}/payouts`,
    },
    { tx, entityRef: `orgPayout:${payoutId}` },
  );
  const notifyEmails = await stageOrgPayoutEmailsInTx(tx, {
    organizationId: payout.organizationId,
    orgName: payout.organization.name,
    payoutId,
    status: kind,
    amountPaise: payout.netPayoutPaise,
    currency: payout.currency,
    tdsAmountPaise: 0,
    reason: reason.slice(0, 200),
  });

  return {
    wasNoOp: false,
    status: kind as PayoutStatus,
    notifyStaged,
    notifyEmails,
    notify: {
      organizationId: payout.organizationId,
      orgName: payout.organization.name,
      amountPaise: payout.netPayoutPaise,
      netPayoutPaise: payout.netPayoutPaise,
      tdsAmountPaise: 0,
      currency: payout.currency,
    },
  };
}

/** Audit row plus outbound webhook for a payout that failed or was reversed; the audit text never carries the gateway's words. */
async function recordOrgPayoutFailureOutcome(
  tx: Tx,
  p: {
    organizationId: string;
    payoutId: string;
    kind: "FAILED" | "REVERSED";
    reversedFrom?: "COMPLETED" | "PROCESSING";
    reason: string;
  },
): Promise<void> {
  const reversed = p.kind === "REVERSED";
  const when =
    p.reversedFrom === "COMPLETED"
      ? " after completion"
      : p.reversedFrom === "PROCESSING"
        ? " before completion"
        : "";
  await tx.orgAuditLog.create({
    data: {
      organizationId: p.organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: reversed
        ? AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED
        : AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
      description: reversed
        ? `Payout reversed${when}.`
        : `Payout failed: ${payoutNoticeReason("FAILED", p.reason)}`,
      details: {
        payoutId: p.payoutId,
        kind: p.kind,
        ...(p.reversedFrom ? { reversedFrom: p.reversedFrom } : {}),
        reason: p.reason.slice(0, 500),
      },
    },
  });
  await dispatchWebhookEvent({
    prisma: tx,
    organizationId: p.organizationId,
    eventType: "payout.failed",
    payload: {
      payoutId: p.payoutId,
      reason: p.reason || (reversed ? "PAYOUT_REVERSED" : "PAYOUT_FAILED"),
      lastError: p.reason || null,
    },
  });
}

async function markOrgPayoutFailedInternal(
  payoutId: string,
  reason: string,
  kind: "FAILED" | "REVERSED",
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const claim = await tx.organizationPayout.updateMany({
          where: { id: payoutId, status: "PROCESSING" },
          data: {
            status: "FAILED",
            failureReason: reason.slice(0, 500),
            failedAt: new Date(),
          },
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
            `[OrgPayoutService] markOrgPayoutFailedInternal no-op: payout ${payoutId} status=${current.status}`,
          );
          return {
            wasNoOp: true,
            status: current.status,
            notifyStaged: [],
            notifyEmails: [] as StagedRecipientEmail[],
            notify: null,
          };
        }

        return settleUnpaidOrgPayoutTx(tx, { payoutId, kind, reason });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  await Promise.allSettled([
    attemptStagedBells(result.notifyStaged, kind),
    ...(result.notifyEmails.length > 0
      ? [
          attemptStagedEmails(
            result.notifyEmails,
            MONEY_EMAIL_TYPES.PAYOUT_STATUS,
            EMAIL_BUDGET_MS.WEBHOOK,
          ),
        ]
      : result.notify
        ? [emailOrgPayoutFailed(payoutId, kind, reason, result.notify)]
        : []),
  ]);

  return { wasNoOp: result.wasNoOp, status: result.status };
}

async function attemptStagedBells(
  staged: StagedTrigger[],
  site: "COMPLETED" | "FAILED" | "REVERSED",
): Promise<void> {
  try {
    for (const row of staged) await attemptTrigger(row);
  } catch (e) {
    reportSentryError(e, { subsystem: "payments" });
    console.error(`[org-payout] ${site} notify attempt failed:`, e);
  }
}

export async function markOrgPayoutFailed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  return markOrgPayoutFailedInternal(payoutId, reason, "FAILED");
}

export async function markOrgPayoutReversed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  const reversalTx = withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const postClaim = await tx.organizationPayout.updateMany({
          where: { id: payoutId, status: "COMPLETED" },
          data: {
            status: "REVERSED",
            failureReason: reason.slice(0, 500),
            failedAt: new Date(),
          },
        });
        if (postClaim.count > 0) {
          const payout = await tx.organizationPayout.findUniqueOrThrow({
            where: { id: payoutId },
            select: {
              id: true,
              organizationId: true,
              netPayoutPaise: true,
              amountPaise: true,
              tdsAmountPaise: true,
              currency: true,
              organization: { select: { name: true } },
            },
          });

          await tx.organizationEarnings.updateMany({
            where: { orgPayoutId: payoutId, status: "PAID" },
            data: { status: "READY", orgPayoutId: null },
          });

          const orgTds = payout.tdsAmountPaise ?? 0;
          const recoveredPaise = await clawbackRecoveredPaise(tx, payoutId);
          assertOrgPayoutWithholdingIdentity(payout, recoveredPaise);
          if (payout.netPayoutPaise - recoveredPaise > 0) {
            await postLedgerTxn(tx, {
              idempotencyKey: `orgpayout-reversal:${payoutId}`,
              kind: "ORG_PAYOUT",
              payoutId,
              postings: buildPayoutReversalPostings({
                payableAccount: {
                  kind: "ORG_PAYABLE",
                  organizationId: payout.organizationId,
                },
                grossPayablePaise: payout.netPayoutPaise - recoveredPaise,
                netCashPaise: payout.amountPaise,
                tdsPaise: orgTds,
              }),
            });
          }

          await recordOrgTdsReversal(tx, {
            orgPayoutId: payoutId,
            organizationId: payout.organizationId,
            reversalBasis: { kind: "FULL" },
          });
          await releaseClawbackRecovery(tx, payoutId);
          const voided = await voidClawbacksRaisedOnPayout(tx, {
            payoutId,
            organizationId: payout.organizationId,
          });
          if (voided.alreadyRecoveredPaise > 0) {
            await recordSystemEventSafe({
              db: tx,
              organizationId: payout.organizationId,
              category: "PAYOUT",
              severity: "ERROR",
              message: `PAYOUT_REVERSED_CLAWBACK_ALREADY_RECOVERED: org payout ${payoutId} was reversed after ${voided.alreadyRecoveredPaise}p of the clawbacks raised on it had been recovered from later payouts; that sum is owed back to the organisation`,
              context: {
                payoutId,
                organizationId: payout.organizationId,
                ...voided,
              },
            });
          }

          await recordOrgPayoutFailureOutcome(tx, {
            organizationId: payout.organizationId,
            payoutId,
            kind: "REVERSED",
            reversedFrom: "COMPLETED",
            reason,
          });

          const notifyStaged = await notifyOrgPayoutFailed(
            payout.organizationId,
            {
              orgName: payout.organization.name,
              payoutId,
              amountPaise: payout.amountPaise,
              netPayoutPaise: payout.netPayoutPaise,
              tdsAmountPaise: payout.tdsAmountPaise ?? 0,
              currency: payout.currency,
              reason: reason.slice(0, 200),
              kind: "REVERSED",
              dashboardUrl: `${getAppUrl()}/dashboard/organization/${payout.organizationId}/payouts`,
            },
            { tx, entityRef: `orgPayout:${payoutId}` },
          );
          const notifyEmails = await stageOrgPayoutEmailsInTx(tx, {
            organizationId: payout.organizationId,
            orgName: payout.organization.name,
            payoutId,
            status: "REVERSED",
            amountPaise: payout.amountPaise,
            currency: payout.currency,
            tdsAmountPaise: payout.tdsAmountPaise ?? 0,
            reason: reason.slice(0, 200),
          });

          return {
            wasNoOp: false,
            status: "REVERSED" as PayoutStatus,
            notifyStaged,
            notifyEmails,
            notify: {
              organizationId: payout.organizationId,
              orgName: payout.organization.name,
              amountPaise: payout.amountPaise,
              netPayoutPaise: payout.netPayoutPaise,
              tdsAmountPaise: payout.tdsAmountPaise ?? 0,
              currency: payout.currency,
            },
          };
        }

        const preClaim = await tx.organizationPayout.updateMany({
          where: {
            id: payoutId,
            status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
          },
          data: {
            status: "REVERSED",
            failureReason: reason.slice(0, 500),
            failedAt: new Date(),
          },
        });
        if (preClaim.count === 0) {
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
          return {
            wasNoOp: true,
            status: current.status,
            notifyStaged: [],
            notifyEmails: [] as StagedRecipientEmail[],
            notify: null,
          };
        }

        return settleUnpaidOrgPayoutTx(tx, {
          payoutId,
          kind: "REVERSED",
          reversedFrom: "PROCESSING",
          reason,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  const txResult = await reversalTx.catch(async (err: unknown) => {
    if (err instanceof OrgPayoutWithholdingMismatchError) {
      await reportOrgPayoutWithholdingMismatch(err, "markOrgPayoutReversed");
    }
    throw err;
  });

  if (!txResult.wasNoOp) {
    await Promise.allSettled([
      attemptStagedBells(txResult.notifyStaged, "REVERSED"),
      ...(txResult.notifyEmails.length > 0
        ? [
            attemptStagedEmails(
              txResult.notifyEmails,
              MONEY_EMAIL_TYPES.PAYOUT_STATUS,
              EMAIL_BUDGET_MS.WEBHOOK,
            ),
          ]
        : txResult.notify
          ? [
              emailOrgPayoutFailed(
                payoutId,
                "REVERSED",
                reason,
                txResult.notify,
              ),
            ]
          : []),
    ]);
  }

  return { wasNoOp: txResult.wasNoOp, status: txResult.status };
}

export interface OrgBatchResult {
  success: boolean;
  orgsScanned: number;
  payoutsCreated: number;
  payoutsAlreadyExisted: number;
  totalAmount: number;
  skippedNotEligible: number;
  /** Orgs whose batch threw something other than a lock or validation refusal. */
  failed: number;
  /** Eligible orgs this run did not reach because `limit` was spent. */
  remaining: number;
  errors: string[];
}

/**
 * The scheduled org batch. Each org's period starts at its oldest READY,
 * unbatched earning before `periodEnd`, so a late-released or returned earning
 * is still batched; the key is per org per `periodEnd`, one payout per window.
 */
export async function createOrgPayoutBatches(opts?: {
  periodEnd?: Date;
  /** Caps the payouts created plus failures; already-batched and refused orgs do not count. */
  limit?: number;
  /** The admin who started a manual run; scheduled runs leave it unset and mint as SYSTEM_CRON. */
  createdBy?: string;
}): Promise<OrgBatchResult> {
  const { createHash } = await import("crypto");
  const { getActiveOrgMaintenanceWindow } = await import("@/lib/maintenance");
  const periodEnd = opts?.periodEnd ?? new Date();

  const result: OrgBatchResult = {
    success: false,
    orgsScanned: 0,
    payoutsCreated: 0,
    payoutsAlreadyExisted: 0,
    totalAmount: 0,
    skippedNotEligible: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };

  const eligible = await prisma.organizationEarnings.groupBy({
    by: ["organizationId"],
    where: {
      status: "READY",
      orgPayoutId: null,
      createdAt: { lt: periodEnd },
    },
    orderBy: { organizationId: "asc" },
    _count: true,
    _min: { createdAt: true },
  });
  result.orgsScanned = eligible.length;

  let visited = 0;
  const failures: Array<{ organizationId: string; error: string }> = [];
  for (const row of eligible) {
    if (
      opts?.limit !== undefined &&
      result.payoutsCreated + failures.length >= opts.limit
    ) {
      break;
    }
    visited += 1;
    const orgId = row.organizationId;
    const orgMaint = await getActiveOrgMaintenanceWindow(orgId);
    if (orgMaint && orgMaint.phase === "OFFLINE") {
      result.skippedNotEligible++;
      result.errors.push(
        `${orgId}: org-specific OFFLINE maintenance active (${orgMaint.reason ?? "no reason"}); skipped`,
      );
      continue;
    }

    const periodStart = row._min.createdAt ?? periodEnd;
    const idempotencyKey = createHash("sha256")
      .update(`scheduled:${orgId}:${periodEnd.toISOString()}`)
      .digest("hex");

    try {
      const out = await createOrgPayoutBatch(orgId, periodStart, periodEnd, {
        idempotencyKey,
        notes: `Weekly cron batch ${periodStart.toISOString()} → ${periodEnd.toISOString()}`,
        createdBy: opts?.createdBy,
      });
      if (out.alreadyExisted) {
        result.payoutsAlreadyExisted++;
      } else {
        result.payoutsCreated++;
        result.totalAmount += out.amountPaise;
      }
    } catch (err) {
      if (err instanceof PayoutLockError) {
        result.errors.push(`${orgId}: payout lock held; skipped`);
        continue;
      }
      if (err instanceof PayoutValidationError) {
        result.skippedNotEligible++;
        result.errors.push(`${orgId}: ${err.message}`);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ organizationId: orgId, error: message.slice(0, 300) });
      result.errors.push(`${orgId}: ${message}`);
    }
  }

  result.failed = failures.length;
  if (failures.length > 0) {
    reportSentryMessage("org-payout-batch-failures", {
      subsystem: "payments",
      level: "error",
      extra: { periodEnd: periodEnd.toISOString(), failures },
      fingerprint: ["org-payout-batch-failures"],
    });
  }
  result.remaining = eligible.length - visited;
  result.success = true;
  return result;
}
