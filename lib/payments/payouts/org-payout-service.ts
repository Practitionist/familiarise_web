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
import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentGateway, PayoutStatus } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { assertPayoutBalance } from "./balance-preflight";
import { PAYOUT_CONSTANTS } from "./constants";
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
} from "./clawback-recovery";
import { postPayoutClawback } from "@/lib/payments/operations/reversal-engine";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { PAYOUT_ALLOWED_FROM } from "@/lib/enterprise/transitions";
import {
  notifyOrgPayoutCompleted,
  notifyOrgPayoutFailed,
} from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { sendOrgPayoutFailedEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/url";
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
              orgForCompliance?.taxInfo?.panEncrypted,
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
                description: `Payout batch created: ${readyEarnings.length} earnings, ${amountAfterTds} paise ${first.currency} (after ${tds.tdsAmountPaise} paise TDS ${tds.tdsSection})`,
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
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Approve a PENDING organization payout with maker-checker enforcement (#1898).
 */
export async function approveOrgPayout(
  payoutId: string,
  adminUserId: string,
): Promise<void> {
  const existing = await prisma.organizationPayout.findUnique({
    where: { id: payoutId },
    select: { status: true, createdBy: true, organizationId: true },
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

  const makerCheckerRequired =
    process.env.PAYOUT_MAKER_CHECKER_REQUIRED !== "false";
  if (
    makerCheckerRequired &&
    existing.createdBy &&
    existing.createdBy === adminUserId
  ) {
    const activeAdminCount =
      typeof (prisma as unknown as { user?: { count?: unknown } }).user
        ?.count === "function"
        ? await prisma.user.count({
            where: { role: "ADMIN" },
          })
        : 2;
    if (activeAdminCount > 1) {
      throw new PayoutMakerCheckerError(
        "Maker-checker violation: the admin who created this org payout batch cannot also approve it.",
      );
    }
    if (typeof recordSystemEventSafe === "function") {
      await recordSystemEventSafe({
        organizationId: existing.organizationId,
        category: "PAYOUT",
        severity: "WARN",
        message: `Solo-admin bootstrap exception: admin ${adminUserId} self-approved org payout ${payoutId}`,
        context: {
          action: "ORG_PAYOUT_SOLO_ADMIN_SELF_APPROVAL",
          actorUserId: adminUserId,
          payoutId,
          adminUserId,
          activeAdminCount,
        },
      });
    }
  }

  const approved = await prisma.organizationPayout.updateMany({
    where: { id: payoutId, status: { in: PAYOUT_ALLOWED_FROM.APPROVED } },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedBy: adminUserId,
    },
  });
  if (approved.count === 0) {
    const current = await prisma.organizationPayout.findUnique({
      where: { id: payoutId },
      select: { status: true },
    });
    if (!current) {
      throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
    }
    throw new PayoutValidationError(
      `Payout cannot be approved from status: ${current.status}`,
      409,
    );
  }
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
      description: `Payout ${payout.id} failed before disbursement due to post-batch refund shortfall`,
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

          const claim = await tx.organizationPayout.updateMany({
            where: {
              id: payoutId,
              status: { in: PAYOUT_ALLOWED_FROM.PROCESSING },
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
              description: `Payout ${payoutId} moved to PROCESSING`,
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
  )
    .then(async (result) => {
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
    },
  });

  if (payout.paymentGateway !== "RAZORPAY") {
    throw new PayoutValidationError(
      `Payout ${payoutId}: gateway ${payout.paymentGateway} has no payout rail; only RazorpayX disburses`,
      400,
    );
  }

  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: payout.organizationId },
    select: {
      status: true,
      razorpayContactId: true,
      razorpayFundAccountId: true,
    },
  });
  const fundAccountId = account?.razorpayFundAccountId ?? null;
  if (!fundAccountId) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: organization has no razorpayFundAccountId on its payout account`,
      400,
    );
  }
  if (account?.status !== "VERIFIED") {
    throw new PayoutValidationError(
      `Payout ${payoutId}: organization payout account is ${account?.status ?? "missing"}, not VERIFIED — refusing to submit`,
      409,
    );
  }

  const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
  const sdk = getRazorpayPayoutsService();
  const idempotencyKey = sdk.generateIdempotencyKey(payoutId);
  const mode = sdk.determinePayoutMode(payout.amountPaise, "bank_account");

  const preflight = await assertPayoutBalance(payout.amountPaise);
  if (!preflight.ok) {
    console.warn(
      `[OrgPayoutService] Holding payout ${payoutId} — ${preflight.reason}`,
    );
    return;
  }

  const response = await sdk.createPayout({
    fundAccountId,
    amount: payout.amountPaise,
    currency: payout.currency,
    mode,
    purpose: "payout",
    referenceId: payoutId,
    narration: `Familiarise org payout ${payoutId}`,
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
        description: `Payout ${payoutId} submission rejected by gateway (4xx)`,
        details: { payoutId, reason: reason.slice(0, 500) },
      },
    });
  });
}

export interface OrgProcessingResult {
  scanned: number;
  advanced: number;
  errors: string[];
}

export async function processPendingOrgPayouts(): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };

  const pending = await prisma.organizationPayout.findMany({
    where: { status: { in: PAYOUT_ALLOWED_FROM.PROCESSING } },
    select: { id: true },
  });
  result.scanned = pending.length;

  for (const p of pending) {
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

  const redrive = await redriveStaleProcessingOrgPayouts();
  result.scanned += redrive.scanned;
  result.advanced += redrive.advanced;
  result.errors.push(...redrive.errors);

  return result;
}

const ORG_PROCESSING_REDRIVE_AFTER_MS = 60 * 60 * 1000;

async function redriveStaleProcessingOrgPayouts(): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };
  const staleBefore = new Date(Date.now() - ORG_PROCESSING_REDRIVE_AFTER_MS);
  const stale = await prisma.organizationPayout.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: staleBefore } },
    select: { id: true, gatewayPayoutId: true, paymentGateway: true },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  result.scanned = stale.length;

  for (const p of stale) {
    try {
      if (!p.gatewayPayoutId) {
        await submitOrgPayoutToGateway(p.id);
        result.advanced++;
        continue;
      }

      const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
      const sdk = getRazorpayPayoutsService();
      const remote = await sdk.fetchPayout(p.gatewayPayoutId);
      switch (remote.status) {
        case "processed":
          await markOrgPayoutCompleted(p.id);
          result.advanced++;
          break;
        case "failed":
          await markOrgPayoutFailed(
            p.id,
            remote.failureReason ?? "Gateway reports the payout failed",
          );
          result.advanced++;
          break;
        case "cancelled":
        case "rejected":
          await markOrgPayoutFailed(
            p.id,
            `Gateway reports the payout ${remote.status}`,
          );
          result.advanced++;
          break;
        case "reversed":
          await markOrgPayoutReversed(
            p.id,
            "Gateway reports the payout reversed",
          );
          result.advanced++;
          break;
        default:
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        classifyGatewaySubmissionError(err) === "PERMANENT_4XX" ||
        err instanceof PayoutValidationError
      ) {
        await markOrgPayoutFailed(p.id, `redrive rejected: ${message}`);
        result.advanced++;
        continue;
      }
      reportSentryError(err, { subsystem: "payments" });
      result.errors.push(`OrgPayout redrive ${p.id}: ${message}`);
    }
  }

  return result;
}

type OrgPayoutCompletionShortfall = {
  organizationId: string;
  shortfallPaise: number;
  owedPaise: number;
  netPayoutPaise: number;
};

async function detectAndAccrueOrgPayoutCompletionShortfall(
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
  const shortfallPaise = payout.netPayoutPaise - owedPaise;
  if (typeof tx.organizationPayout?.update === "function") {
    await tx.organizationPayout.update({
      where: { id: payout.id },
      data: {
        clawbackAmountPaise: { increment: shortfallPaise },
      },
    });
  } else {
    await tx.organizationPayout.updateMany({
      where: { id: payout.id },
      data: {
        clawbackAmountPaise: { increment: shortfallPaise },
      },
    });
  }
  await postPayoutClawback(tx, {
    refundId: `shortfall:${payout.id}`,
    payoutId: payout.id,
    amountPaise: shortfallPaise,
    organizationId: payout.organizationId,
  });
  return {
    organizationId: payout.organizationId,
    shortfallPaise,
    owedPaise,
    netPayoutPaise: payout.netPayoutPaise,
  };
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
    await notifyOrgPayoutCompleted(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.amountPaise,
      netPayoutPaise: result.notify.netPayoutPaise,
      tdsAmountPaise: result.notify.tdsAmountPaise,
      currency: result.notify.currency,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }
}

export async function markOrgPayoutCompleted(payoutId: string): Promise<{
  wasNoOp: boolean;
  status: PayoutStatus;
}> {
  const completion = prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    if (claim.count === 0) {
      const status = await readOrgPayoutCurrentStatus(tx, payoutId);
      console.log(
        `[OrgPayoutService] markOrgPayoutCompleted no-op: payout ${payoutId} status=${status}`,
      );
      return {
        wasNoOp: true,
        status,
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
        organization: { select: { name: true } },
      },
    });

    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "BATCHED" },
      data: { status: "PAID" },
    });

    const completionShortfall =
      await detectAndAccrueOrgPayoutCompletionShortfall(tx, payout);

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
      );
    }

    return {
      wasNoOp: false,
      status: "COMPLETED" as PayoutStatus,
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
          ? { organizationId: payout.organizationId, tdsAmountPaise: orgTds }
          : null,
      shortfall: completionShortfall,
    };
  });

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

async function markOrgPayoutFailedInternal(
  payoutId: string,
  reason: string,
  kind: "FAILED" | "REVERSED",
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  const result = await prisma.$transaction(async (tx) => {
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
        throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutFailedInternal no-op: payout ${payoutId} status=${current.status}`,
      );
      return {
        wasNoOp: true,
        status: current.status,
        notifyStaged: [],
        notify: null,
      };
    }

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

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action:
          kind === "REVERSED"
            ? AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED
            : AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description:
          kind === "REVERSED"
            ? `Payout ${payoutId} reversed by gateway: ${reason.slice(0, 200)}`
            : `Payout ${payoutId} failed at gateway: ${reason.slice(0, 200)}`,
        details: { payoutId, kind, reason: reason.slice(0, 500) },
      },
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

    return {
      wasNoOp: false,
      status: "FAILED" as PayoutStatus,
      notifyStaged,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        amountPaise: payout.netPayoutPaise,
        netPayoutPaise: payout.netPayoutPaise,
        tdsAmountPaise: 0,
        currency: payout.currency,
      },
    };
  });

  await attemptStagedBells(result.notifyStaged, kind);
  if (result.notify) {
    await emailOrgPayoutFailed(payoutId, kind, reason, result.notify);
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}

async function attemptStagedBells(
  staged: StagedTrigger[],
  site: "FAILED" | "REVERSED",
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
  // Post-settlement reversal (COMPLETED → REVERSED) posts inverse ledger entries and TDS reversal; pre-settlement falls through to FAILED.
  const reversalCompletion = prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "COMPLETED" },
      data: {
        status: "REVERSED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0)
      return { claimed: false, notifyStaged: [], notify: null };

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

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED,
        description: `Payout ${payoutId} reversed by bank after completion: ${reason.slice(0, 200)}`,
        details: {
          payoutId,
          kind: "REVERSED",
          reversedFrom: "COMPLETED",
          reason: reason.slice(0, 500),
        },
      },
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

    return {
      claimed: true,
      notifyStaged,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        amountPaise: payout.amountPaise,
        netPayoutPaise: payout.netPayoutPaise,
        tdsAmountPaise: payout.tdsAmountPaise ?? 0,
        currency: payout.currency,
      },
    };
  });

  const completedResult = await reversalCompletion.catch(
    async (err: unknown) => {
      if (err instanceof OrgPayoutWithholdingMismatchError) {
        await reportOrgPayoutWithholdingMismatch(err, "markOrgPayoutReversed");
      }
      throw err;
    },
  );

  if (completedResult.claimed) {
    await attemptStagedBells(completedResult.notifyStaged, "REVERSED");
    if (completedResult.notify) {
      await emailOrgPayoutFailed(
        payoutId,
        "REVERSED",
        reason,
        completedResult.notify,
      );
    }
    return { wasNoOp: false, status: "REVERSED" as PayoutStatus };
  }

  return markOrgPayoutFailedInternal(payoutId, reason, "REVERSED");
}

export interface OrgBatchResult {
  success: boolean;
  orgsScanned: number;
  payoutsCreated: number;
  payoutsAlreadyExisted: number;
  totalAmount: number;
  skippedNotEligible: number;
  errors: string[];
}

export async function createOrgPayoutBatches(opts?: {
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<OrgBatchResult> {
  const { createHash } = await import("crypto");
  const { getActiveOrgMaintenanceWindow } = await import("@/lib/maintenance");
  const periodEnd = opts?.periodEnd ?? new Date();
  const periodStart =
    opts?.periodStart ??
    new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const result: OrgBatchResult = {
    success: false,
    orgsScanned: 0,
    payoutsCreated: 0,
    payoutsAlreadyExisted: 0,
    totalAmount: 0,
    skippedNotEligible: 0,
    errors: [],
  };

  const eligible = await prisma.organizationEarnings.groupBy({
    by: ["organizationId"],
    where: {
      status: "READY",
      orgPayoutId: null,
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    _count: true,
  });
  result.orgsScanned = eligible.length;

  for (const row of eligible) {
    const orgId = row.organizationId;
    const orgMaint = await getActiveOrgMaintenanceWindow(orgId);
    if (orgMaint && orgMaint.phase === "OFFLINE") {
      result.skippedNotEligible++;
      result.errors.push(
        `${orgId}: org-specific OFFLINE maintenance active (${orgMaint.reason ?? "no reason"}); skipped`,
      );
      continue;
    }

    const idempotencyKey = createHash("sha256")
      .update(`${orgId}:${periodStart.toISOString()}`)
      .digest("hex");

    try {
      const out = await createOrgPayoutBatch(orgId, periodStart, periodEnd, {
        idempotencyKey,
        notes: `Weekly cron batch ${periodStart.toISOString()} → ${periodEnd.toISOString()}`,
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
      result.errors.push(`${orgId}: ${message}`);
    }
  }

  result.success = true;
  return result;
}
