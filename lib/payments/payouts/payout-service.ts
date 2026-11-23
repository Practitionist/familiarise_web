/**
 * Payout Service
 * Provider-agnostic consultant payout orchestration with admin approval workflow.
 */

import { casMiss } from "@/lib/cron/run-counters";
import { isMakerCheckerDisbursementBlocked } from "./maker-checker";
import * as Sentry from "@sentry/nextjs";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  recordSystemEvent,
  recordSystemEventSafe,
} from "@/lib/enterprise/system-events";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import {
  PayoutStatus,
  PayoutMethod,
  PayoutAccountType,
  PaymentGateway,
  EarningStatus,
  Prisma,
} from "@prisma/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Refusal } from "@/lib/errors/refusal";
import {
  INSTANT_PAYOUT_AUTO_APPROVE_PAISE,
  PAYOUT_CONSTANTS,
} from "./constants";
import {
  payoutAccountHold,
  payoutEligibilityReason,
  type PayoutEligibilityReason,
} from "./payout-requirements";
import { isUnimplementedGateway } from "@/lib/payments/constants";
import {
  getRazorpayPayoutsService,
  isDefinitiveGatewayRejection,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  clawbackRecoveredPaise,
  outstandingClawbackPaise,
  recoverClawbackOnPayout,
  recoverablePaise,
  releaseClawbackRecovery,
  voidClawbacksRaisedOnPayout,
} from "./clawback-recovery";
import { postConsultantPayoutClawback } from "@/lib/payments/operations/reversal-engine";
import { randomUUID } from "crypto";
import {
  acquireLock,
  releaseLock,
  isMockRedis,
  checkRedisHealth,
} from "@/lib/redis";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/with-cron-lock";
import { assertPayoutBalance } from "./balance-preflight";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { resolveEffectiveTdsRate } from "@/lib/compliance/tds";
import {
  earningsGrossPaise,
  planConsultantPayoutTds,
  type ConsultantTdsInput,
  type ConsultantTdsPlan,
} from "./consultant-tds";
import {
  getCurrentFYCumulativePayments,
  getIndianFinancialYear,
  recordTDSDeduction,
  recordTdsReversal,
} from "@/lib/payments/tax/tds-service";
import { notifyPayoutFailed, notifyPayoutProcessed } from "@/lib/novu/service";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
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
import { goHref } from "@/lib/dashboard/go";
import { formatNotificationMoney } from "@/lib/novu/humanize";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  buildPayoutCompletionPostings,
  buildPayoutReversalPostings,
  DISPUTE_GATED_PAYMENT_WHERE,
  PayoutMakerCheckerError,
  REFUND_GATED_PAYMENT_WHERE,
  resolveCompletionTdsWindow,
  resolvePayoutMsmeDeadline,
} from "./shared-lifecycle";

export { PayoutMakerCheckerError };

export interface PayoutSummary {
  id: string;
  consultantProfileId: string;
  consultantName: string;
  consultantEmail: string | null;
  amount: number;
  currency: string;
  status: PayoutStatus;
  method: PayoutMethod;
  provider: PaymentGateway;
  earningsCount: number;
  createdAt: Date;
}

export interface PayoutResult {
  payoutId: string;
  success: boolean;
  providerPayoutId?: string;
  error?: string;
  /** True when another run's CAS claim won this payout (APPROVED → PROCESSING matched 0 rows). */
  skipped?: boolean;
}

export interface BatchResult {
  batchId: string;
  total: number;
  successful: number;
  failed: number;
  results: PayoutResult[];
}

export interface ConsultantPayoutEligibility {
  consultantProfileId: string;
  isEligible: boolean;
  readyAmount: number;
  minimumAmount: number;
  /** A VERIFIED default account; an unverified one still reads false. */
  hasPayoutAccount: boolean;
  defaultAccountId?: string;
  provider?: PaymentGateway;
  /** The first failing gate in batch order; null when eligible. */
  reason: PayoutEligibilityReason | null;
}

export async function getPendingPayouts(): Promise<PayoutSummary[]> {
  const payouts = await prisma.consultantPayout.findMany({
    where: { status: PayoutStatus.PENDING },
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
      earnings: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return payouts.map((p) => ({
    id: p.id,
    consultantProfileId: p.consultantProfileId,
    consultantName: p.consultantProfile.user.name || "Unknown",
    consultantEmail: p.consultantProfile.user.email,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method,
    provider: p.provider,
    earningsCount: p.earnings.length,
    createdAt: p.createdAt,
  }));
}

export async function getPayoutById(payoutId: string) {
  return prisma.consultantPayout.findUnique({
    where: { id: payoutId },
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
          payoutAccounts: true,
        },
      },
      earnings: {
        include: {
          payment: { select: { id: true, amount: true, createdAt: true } },
        },
      },
    },
  });
}

export async function checkPayoutEligibility(
  consultantProfileId: string,
): Promise<ConsultantPayoutEligibility> {
  const readyEarningsAgg = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });

  const readyAmount =
    sumPaise(readyEarningsAgg._sum.consultantSharePaise) -
    sumPaise(readyEarningsAgg._sum.refundedShareAmount);

  const defaultAccount = await prisma.payoutAccount.findFirst({
    where: { consultantProfileId, isDefault: true },
    select: {
      id: true,
      provider: true,
      isVerified: true,
      payoutsAllowedAfter: true,
      payoutsFrozenAt: true,
    },
  });
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
    select: { isIndianResident: true },
  });
  const verifiedAccount = defaultAccount?.isVerified ? defaultAccount : null;
  const outstandingClawback = await outstandingClawbackPaise(prisma, {
    rail: "CONSULTANT",
    consultantProfileId,
  });

  const reason = payoutEligibilityReason({
    livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    isIndianResident: taxInfo?.isIndianResident ?? true,
    defaultAccount,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    outstandingClawbackPaise: outstandingClawback,
    clawbackPausePaise: PAYOUT_CONSTANTS.CLAWBACK_RECOVERY_PAUSE_PAISE,
  });

  return {
    consultantProfileId,
    isEligible: reason === null,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    hasPayoutAccount: !!verifiedAccount,
    defaultAccountId: verifiedAccount?.id,
    provider: verifiedAccount?.provider,
    reason,
  };
}

const PAYOUT_BATCH_LOCK_KEY = "lock:payout_batch_creation";
const PAYOUT_BATCH_LOCK_TTL = 15 * 60_000;

interface PayoutBatchRun {
  batchId: string;
  minted: number;
  /** Consultants whose mint threw; the rest of the batch still ran. */
  failed: number;
}

export async function createPayoutBatch(
  consultantProfileIds?: string[],
  opts?: { createdBy?: string },
): Promise<PayoutBatchRun> {
  const { batchId, minted, failed } = await runPayoutBatch(
    consultantProfileIds,
    opts ?? {},
  );
  return { batchId, minted, failed };
}

export interface PayoutBatchSlice extends PayoutBatchRun {
  remaining: number;
}

/**
 * One bounded slice of the scheduled batch: mints at most `limit` payouts and
 * skips consultants already given a batch payout since `windowStart`, so every
 * slice of one window batches each consultant at most once.
 */
export async function createPayoutBatchSlice(opts: {
  limit: number;
  windowStart?: Date;
  createdBy?: string;
}): Promise<PayoutBatchSlice> {
  return runPayoutBatch(undefined, opts);
}

async function runPayoutBatch(
  consultantProfileIds: string[] | undefined,
  opts: { createdBy?: string; limit?: number; windowStart?: Date },
): Promise<PayoutBatchSlice> {
  // Fail closed when Redis is mocked or unreachable so concurrent callers cannot double-batch.
  if (isMockRedis()) {
    throw new CronLockUnavailableError("create-payout-batch");
  }
  if (!(await checkRedisHealth())) {
    throw new CronLockUnavailableError("create-payout-batch");
  }

  const lockToken = await acquireLock(
    PAYOUT_BATCH_LOCK_KEY,
    PAYOUT_BATCH_LOCK_TTL,
  );
  if (!lockToken) {
    throw new CronLockHeldError("create-payout-batch");
  }

  try {
    const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;

    const eligibleConsultants = await prisma.consultantEarnings.groupBy({
      by: ["consultantProfileId"],
      where: {
        status: EarningStatus.READY,
        payoutId: null,
        ...(consultantProfileIds?.length
          ? { consultantProfileId: { in: consultantProfileIds } }
          : {}),
        ...(opts.windowStart
          ? {
              consultantProfile: {
                payouts: {
                  none: { kind: null, createdAt: { gte: opts.windowStart } },
                },
              },
            }
          : {}),
      },
      orderBy: { consultantProfileId: "asc" },
      _sum: { consultantSharePaise: true },
      having: {
        consultantSharePaise: {
          _sum: { gte: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT },
        },
      },
    });

    // Only a minted payout spends the slice budget; a skipped consultant is a cheap read.
    let minted = 0;
    let visited = 0;
    const failures: Array<{ consultantProfileId: string; error: string }> = [];
    for (const { consultantProfileId } of eligibleConsultants) {
      if (opts.limit !== undefined && minted >= opts.limit) break;
      visited += 1;
      try {
        const payout = await mintConsultantPayout({
          consultantProfileId,
          batchId,
          idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
          createdBy: opts.createdBy ?? "SYSTEM_CRON",
          autoApprove: (amount) =>
            amount < PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD,
        });
        if (payout) minted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[Payouts] Mint failed for consultant ${consultantProfileId} in ${batchId}: ${message}`,
        );
        failures.push({ consultantProfileId, error: message.slice(0, 300) });
      }
    }

    if (failures.length > 0) {
      reportSentryMessage("payout-batch-mint-failures", {
        subsystem: "payments",
        level: "error",
        extra: { batchId, failed: failures.length, failures },
      });
    }

    return {
      batchId,
      minted,
      failed: failures.length,
      remaining: eligibleConsultants.length - visited,
    };
  } finally {
    await releaseLock(PAYOUT_BATCH_LOCK_KEY, lockToken);
  }
}

interface ConsultantPayoutDraft {
  consultantProfileId: string;
  batchId: string;
  idempotencyKey: string;
  kind?: "INSTANT";
  createdBy?: string;
  autoApprove: (amountPaise: number) => boolean;
}

/**
 * Atomically sums a consultant's READY earnings, creates the payout row, and
 * claims the earnings READY → BATCHED inside a single transaction.
 */
function resolvePayoutMethodFromAccountType(
  accountType: PayoutAccountType,
): PayoutMethod {
  switch (accountType) {
    case PayoutAccountType.BANK_ACCOUNT:
      return PayoutMethod.BANK_TRANSFER;
    case PayoutAccountType.UPI:
      return PayoutMethod.UPI;
    case PayoutAccountType.STRIPE_CONNECT:
      return PayoutMethod.STRIPE_TRANSFER;
    default: {
      const unhandled: never = accountType;
      throw new Error(`Unhandled payout account type: ${String(unhandled)}`);
    }
  }
}

function resolveMintedPayoutCreator(
  draft: ConsultantPayoutDraft,
  msmeUserId: string | null | undefined,
): string {
  if (draft.createdBy) {
    return draft.createdBy;
  }
  if (draft.kind === "INSTANT") {
    return msmeUserId ?? "CONSULTANT_SELF";
  }
  return "SYSTEM_CRON";
}

async function mintConsultantPayout(
  draft: ConsultantPayoutDraft,
): Promise<{ id: string; amount: number; status: PayoutStatus } | null> {
  const { consultantProfileId, batchId } = draft;

  const account = await prisma.payoutAccount.findFirst({
    where: {
      consultantProfileId,
      isDefault: true,
      isVerified: true,
    },
  });

  if (!account) {
    console.warn(
      `No verified payout account for consultant ${consultantProfileId}`,
    );
    return null;
  }

  const hold = payoutAccountHold(account);
  if (hold) {
    console.warn(`Skipping consultant ${consultantProfileId}: ${hold}`);
    return null;
  }

  // Skip unimplemented gateways before claiming earnings into BATCHED.
  if (isUnimplementedGateway(account.provider)) {
    console.warn(
      `Skipping consultant ${consultantProfileId}: payout account is on ` +
        `"${account.provider}", which has no implementation.`,
    );
    return null;
  }

  const method = resolvePayoutMethodFromAccountType(account.accountType);

  const msmeProfile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      userId: true,
      msmeStatus: true,
      writtenAgreementWithFamiliarise: true,
    },
  });

  const resolvedCreatedBy = resolveMintedPayoutCreator(
    draft,
    msmeProfile?.userId,
  );

  // Serializable: a clawback committing after the pause read conflicts and retries.
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // CLAWBACK_RECOVERY_PAUSE: an expert owing more than the pause line is
        // skipped, not netted, until the receivable comes down.
        const owed = await outstandingClawbackPaise(tx, {
          rail: "CONSULTANT",
          consultantProfileId,
        });
        if (owed > PAYOUT_CONSTANTS.CLAWBACK_RECOVERY_PAUSE_PAISE) {
          console.warn(
            `Skipping consultant ${consultantProfileId}: ${owed} paise of clawback outstanding`,
          );
          return null;
        }

        const readyEarnings = await tx.consultantEarnings.findMany({
          where: {
            consultantProfileId,
            status: EarningStatus.READY,
            payoutId: null,
          },
          select: {
            id: true,
            consultantSharePaise: true,
            refundedShareAmount: true,
          },
        });

        if (readyEarnings.length === 0) return null;

        const amount = readyEarnings.reduce(
          (sum, e) =>
            sum + Math.max(e.consultantSharePaise - e.refundedShareAmount, 0),
          0,
        );

        if (amount < PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT) return null;

        const shouldAutoApprove = draft.autoApprove(amount);

        const payout = await tx.consultantPayout.create({
          data: {
            consultantProfileId,
            provider: account.provider,
            amount,
            currency: "INR",
            status: shouldAutoApprove
              ? PayoutStatus.APPROVED
              : PayoutStatus.PENDING,
            method,
            batchId,
            payoutAccountId: account.id,
            idempotencyKey: draft.idempotencyKey,
            kind: draft.kind ?? null,
            createdBy: resolvedCreatedBy,
            approvedAt: shouldAutoApprove ? new Date() : undefined,
            approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
            mustPayByDate: resolvePayoutMsmeDeadline(
              msmeProfile?.msmeStatus,
              msmeProfile?.writtenAgreementWithFamiliarise,
            ),
          },
        });

        await recoverClawbackOnPayout(tx, {
          payee: { rail: "CONSULTANT", consultantProfileId },
          payoutId: payout.id,
          recoverablePaise: recoverablePaise(
            amount,
            PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
            false,
          ),
        });

        // Claim earnings READY → BATCHED; PAID transition only occurs at COMPLETED webhook.
        const linkResult = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: readyEarnings.map((e) => e.id) },
            status: EarningStatus.READY,
            payoutId: null,
          },
          data: {
            payoutId: payout.id,
            status: EarningStatus.BATCHED,
          },
        });

        if (linkResult.count !== readyEarnings.length) {
          throw new Error(
            `Payout linking race: expected ${readyEarnings.length} earnings, linked ${linkResult.count} for consultant ${consultantProfileId}. Rolling back.`,
          );
        }
        return { id: payout.id, amount, status: payout.status };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}

export async function approvePayout(
  payoutId: string,
  adminUserId: string,
): Promise<void> {
  // #1902 — Enforce dual-control maker-checker when a payout carries createdBy.
  const canCheckMakerChecker =
    typeof prisma.consultantPayout.findFirst === "function" ||
    typeof (prisma as { user?: { count?: unknown } }).user?.count ===
      "function";
  if (canCheckMakerChecker) {
    const existing =
      typeof prisma.consultantPayout.findFirst === "function"
        ? await prisma.consultantPayout.findFirst({
            where: { id: payoutId },
            select: { status: true, createdBy: true },
          })
        : await prisma.consultantPayout.findUnique({
            where: { id: payoutId },
            select: { status: true, createdBy: true },
          });
    if (existing?.createdBy && existing.createdBy === adminUserId) {
      const makerCheckerRequired =
        process.env.PAYOUT_MAKER_CHECKER_REQUIRED !== "false";
      const activeAdminCount =
        typeof (
          prisma as { user?: { count?: (args: unknown) => Promise<number> } }
        ).user?.count === "function"
          ? await prisma.user.count({ where: { role: "ADMIN" } })
          : 2;
      if (makerCheckerRequired && activeAdminCount > 1) {
        throw new PayoutMakerCheckerError();
      }
      await recordSystemEventSafe({
        category: "PAYOUT",
        severity: "WARN",
        message: `PAYOUT_SOLO_ADMIN_SELF_APPROVAL: Solo-admin bootstrap self-approval of payout ${payoutId} by ${adminUserId}`,
        context: {
          payoutId,
          adminUserId,
          activeAdminCount,
          makerCheckerRequired,
        },
      });
    }
  }

  // CAS on PENDING so a concurrent reject cannot interleave into an unbacked APPROVED payout.
  const claimed = await prisma.consultantPayout.updateMany({
    where: { id: payoutId, status: PayoutStatus.PENDING },
    data: {
      status: PayoutStatus.APPROVED,
      approvedAt: new Date(),
      approvedBy: adminUserId,
    },
  });
  if (claimed.count === 0) {
    casMiss();
    const current = await prisma.consultantPayout.findUnique({
      where: { id: payoutId },
      select: { status: true },
    });
    if (!current) {
      throw new Error(`Payout ${payoutId} not found`);
    }
    throw new Error(
      `Payout ${payoutId} cannot be approved (current status: ${current.status}). Only PENDING payouts can be approved.`,
    );
  }
}

type StagedConsultantPayoutNotice = {
  userId?: string;
  payoutId: string;
  status: "COMPLETED" | "FAILED" | "REVERSED";
  amountPaise: number;
  currency: string;
  method?: string | null;
  reason?: string | null;
  withheldText?: string;
  bell: StagedTrigger | null;
  emails: StagedRecipientEmail[];
  stagedInTx: boolean;
};

async function stageConsultantPayoutNotice(
  tx: Tx,
  params: {
    userId?: string | null;
    consultantProfileId?: string | null;
    payoutId: string;
    status: "COMPLETED" | "FAILED" | "REVERSED";
    amountPaise: number;
    currency: string;
    method?: string | null;
    reason?: string | null;
    withheldText?: string;
  },
): Promise<StagedConsultantPayoutNotice> {
  const dashboardUrl = `${getAppUrl()}${goHref("expert", "earnings")}`;
  let resolvedUserId = params.userId ?? undefined;
  if (
    !resolvedUserId &&
    params.consultantProfileId &&
    typeof tx.consultantProfile?.findUnique === "function"
  ) {
    const profile = await tx.consultantProfile.findUnique({
      where: { id: params.consultantProfileId },
      select: { userId: true },
    });
    resolvedUserId = profile?.userId;
  }

  let bell: StagedTrigger | null = null;
  let emails: StagedRecipientEmail[] = [];
  let stagedInTx = false;

  if (resolvedUserId && typeof tx.notificationOutbox?.upsert === "function") {
    stagedInTx = true;
    if (params.status === "COMPLETED") {
      const triggered = await notifyPayoutProcessed(
        resolvedUserId,
        {
          amount: params.amountPaise,
          currency: params.currency,
          payoutId: params.payoutId,
          dashboardUrl,
        },
        { tx, entityRef: `consultantPayout:${params.payoutId}` },
      );
      bell = triggered?.staged ?? null;
    } else {
      const triggered = await notifyPayoutFailed(
        resolvedUserId,
        {
          amount: params.amountPaise,
          currency: params.currency,
          payoutId: params.payoutId,
          kind: params.status === "REVERSED" ? "REVERSED" : "FAILED",
          ...(params.reason ? { reason: params.reason } : {}),
          dashboardUrl,
        },
        {
          tx,
          entityRef: `consultantPayout:${params.payoutId}:${params.status}`,
        },
      );
      bell = triggered?.staged ?? null;
    }
  }

  if (
    resolvedUserId &&
    typeof tx.user?.findMany === "function" &&
    typeof tx.failedEmail?.create === "function"
  ) {
    emails = await stagePayoutStatusEmail(tx, {
      userId: resolvedUserId,
      payoutId: params.payoutId,
      status: params.status,
      amountPaise: params.amountPaise,
      currency: params.currency,
      method: params.method,
      reason: params.reason,
      withheldText: params.withheldText,
      dashboardUrl,
    });
  }

  return {
    userId: resolvedUserId,
    payoutId: params.payoutId,
    status: params.status,
    amountPaise: params.amountPaise,
    currency: params.currency,
    method: params.method,
    reason: params.reason,
    withheldText: params.withheldText,
    bell,
    emails,
    stagedInTx,
  };
}

async function flushConsultantPayoutNotice(
  notice: StagedConsultantPayoutNotice | null,
): Promise<void> {
  if (!notice) return;
  try {
    const dashboardUrl = `${getAppUrl()}${goHref("expert", "earnings")}`;
    if (notice.stagedInTx) {
      await Promise.allSettled([
        ...(notice.bell ? [attemptTrigger(notice.bell)] : []),
        attemptStagedEmails(
          notice.emails,
          MONEY_EMAIL_TYPES.PAYOUT_STATUS,
          EMAIL_BUDGET_MS.REQUEST,
        ),
      ]);
      return;
    }

    if (!notice.userId) return;
    await Promise.allSettled([
      notice.status === "COMPLETED"
        ? notifyPayoutProcessed(notice.userId, {
            amount: notice.amountPaise,
            currency: notice.currency,
            payoutId: notice.payoutId,
            dashboardUrl,
          })
        : notifyPayoutFailed(notice.userId, {
            amount: notice.amountPaise,
            currency: notice.currency,
            payoutId: notice.payoutId,
            ...(notice.status === "REVERSED" ? { kind: "REVERSED" } : {}),
            ...(notice.reason ? { reason: notice.reason } : {}),
            dashboardUrl,
          }),
      ...(notice.emails.length > 0
        ? [
            attemptStagedEmails(
              notice.emails,
              MONEY_EMAIL_TYPES.PAYOUT_STATUS,
              EMAIL_BUDGET_MS.REQUEST,
            ),
          ]
        : typeof prisma.user?.findMany === "function" &&
            typeof prisma.failedEmail?.create === "function"
          ? [
              stagePayoutStatusEmail(prisma, {
                userId: notice.userId,
                payoutId: notice.payoutId,
                status: notice.status,
                amountPaise: notice.amountPaise,
                currency: notice.currency,
                method: notice.method,
                reason: notice.reason,
                withheldText: notice.withheldText,
                dashboardUrl,
              }).then((rows) =>
                attemptStagedEmails(
                  rows,
                  MONEY_EMAIL_TYPES.PAYOUT_STATUS,
                  EMAIL_BUDGET_MS.REQUEST,
                ),
              ),
            ]
          : []),
    ]);
  } catch (error) {
    console.error("[payouts] Failed to deliver payout notice:", error);
    reportSentryError(error, { subsystem: "payments", level: "warning" });
  }
}

export async function rejectPayout(
  payoutId: string,
  reason: string,
): Promise<void> {
  let stagedNotice: StagedConsultantPayoutNotice | null = null;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.consultantPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PENDING },
      data: {
        status: PayoutStatus.CANCELLED,
        failureReason: reason,
      },
    });
    if (claimed.count === 0) {
      casMiss();
      const current = await tx.consultantPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new Error("Payout not found");
      }
      throw new Error(
        `Payout ${payoutId} cannot be rejected (current status: ${current.status}). Only PENDING payouts can be rejected.`,
      );
    }

    await tx.consultantEarnings.updateMany({
      where: { payoutId, status: EarningStatus.BATCHED },
      data: {
        payoutId: null,
        status: EarningStatus.READY,
      },
    });
    await releaseClawbackRecovery(tx, payoutId);

    const rejected = await tx.consultantPayout.findUnique({
      where: { id: payoutId },
      select: {
        amount: true,
        currency: true,
        method: true,
        consultantProfile: { select: { userId: true } },
      },
    });
    if (rejected?.consultantProfile?.userId) {
      stagedNotice = await stageConsultantPayoutNotice(tx, {
        userId: rejected.consultantProfile.userId,
        payoutId,
        status: "FAILED",
        amountPaise: Number(rejected.amount),
        currency: rejected.currency,
        method: rejected.method,
        reason,
      });
    }
  });

  await flushConsultantPayoutNotice(stagedNotice);
}

const PAYOUT_PROCESS_LOCK_KEY = "lock:payout_processing";
const PAYOUT_PROCESS_LOCK_TTL = 35 * 60_000;

const APPROVED_PAYOUT_INCLUDE = {
  payoutAccount: true,
  consultantProfile: {
    include: {
      // Only for a payout minted before the snapshot existed (payoutAccountId null).
      payoutAccounts: { where: { isDefault: true, isVerified: true } },
      user: true,
    },
  },
} satisfies Prisma.ConsultantPayoutInclude;

type PayoutDestination = {
  razorpayFundAccId: string | null;
  accountType: string;
  isVerified: boolean;
  payoutsAllowedAfter: Date | null;
  payoutsFrozenAt: Date | null;
};

/**
 * The snapshotted account, or for a pre-snapshot payout the current default,
 * which must also be out of cooling-off. Null when neither may be paid.
 */
function payableDestination(payout: {
  payoutAccount: PayoutDestination | null;
  consultantProfile: { payoutAccounts?: PayoutDestination[] };
}): PayoutDestination | null {
  const snapshot = payout.payoutAccount;
  if (snapshot) {
    return snapshot.isVerified && !snapshot.payoutsFrozenAt ? snapshot : null;
  }
  const fallback = payout.consultantProfile.payoutAccounts?.[0] ?? null;
  return fallback?.isVerified && payoutAccountHold(fallback) === null
    ? fallback
    : null;
}

/** Execution bounds for an on-demand request run within Lambda timeout limits. */
export const REQUEST_PAYOUT_RUN_BOUNDS = {
  budgetMs: 20_000,
  lockTtlMs: 2 * 60_000,
} as const;

/** APPROVED consultant payouts still under the retry cap; the disbursement run's cohort. */
export const APPROVED_PAYOUT_WHERE = {
  status: PayoutStatus.APPROVED,
  retryCount: { lt: PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS },
} satisfies Prisma.ConsultantPayoutWhereInput;

export async function processApprovedPayouts(
  opts: {
    budgetMs?: number;
    lockTtlMs?: number;
    triggeredByUserId?: string;
    /** Caps the disbursements one run attempts; skipped rows do not count. */
    limit?: number;
  } = {},
): Promise<PayoutResult[]> {
  const startedAt = Date.now();
  // Fail closed when Redis is mocked or unreachable before checking the live-payouts flag.
  if (isMockRedis()) {
    throw new CronLockUnavailableError("process-payouts");
  }
  const redisHealthy = await checkRedisHealth();
  if (!redisHealthy) {
    throw new CronLockUnavailableError("process-payouts");
  }

  if (!ENABLE_LIVE_PAYOUTS) {
    console.warn(
      "[Payouts] ENABLE_LIVE_PAYOUTS is off — holding approved consultant payouts.",
    );
    return [];
  }

  const lockToken = await acquireLock(
    PAYOUT_PROCESS_LOCK_KEY,
    opts.lockTtlMs ?? PAYOUT_PROCESS_LOCK_TTL,
  );
  if (!lockToken) {
    console.warn(
      "[Payouts] Payout processing is already in progress. Skipping.",
    );
    return [];
  }

  try {
    const approvedPayouts = await prisma.consultantPayout.findMany({
      where: APPROVED_PAYOUT_WHERE,
      include: APPROVED_PAYOUT_INCLUDE,
      orderBy: [{ approvedAt: "asc" }, { createdAt: "asc" }],
    });

    // Payouts this run's admin approved are skipped up front, so they never count toward the balance check.
    const results: PayoutResult[] = [];
    const disbursable: typeof approvedPayouts = [];
    for (const payout of approvedPayouts) {
      if (
        await isMakerCheckerDisbursementBlocked(
          payout.id,
          payout.approvedBy,
          opts.triggeredByUserId,
        )
      ) {
        results.push({ payoutId: payout.id, success: false, skipped: true });
      } else {
        disbursable.push(payout);
      }
    }

    // The balance must cover what this run can disburse: the oldest `limit` rows, or all of them.
    const batchTotalPaise = disbursable
      .slice(0, opts.limit)
      .reduce((s, p) => s + p.amount, 0);
    const preflight = await assertPayoutBalance(batchTotalPaise);
    if (!preflight.ok) {
      console.warn(`[Payouts] Holding approved batch — ${preflight.reason}`);
      return [];
    }

    for (const payout of disbursable) {
      if (
        opts.budgetMs !== undefined &&
        Date.now() - startedAt >= opts.budgetMs
      ) {
        console.warn(
          `[Payouts] Run budget spent; ${approvedPayouts.length - results.length} approved payout(s) left for the next run`,
        );
        break;
      }
      if (
        opts.limit !== undefined &&
        results.filter((r) => !r.skipped).length >= opts.limit
      ) {
        break;
      }
      const result = await processSinglePayout(payout);
      results.push(result);
    }

    return results;
  } finally {
    await releaseLock(PAYOUT_PROCESS_LOCK_KEY, lockToken);
  }
}

export type InstantPayoutErrorCode =
  | "PAYOUTS_DISABLED"
  | "PAYOUT_NOT_ELIGIBLE"
  | "NOTHING_AVAILABLE"
  | "PAYOUT_BUSY"
  | "INSTANT_ALREADY_TODAY";

export class InstantPayoutError extends Refusal {
  constructor(
    code: InstantPayoutErrorCode,
    userMessage: string,
    httpStatus: number,
    readonly reason: PayoutEligibilityReason | null = null,
  ) {
    super({ code, userMessage, httpStatus, context: { reason } });
    this.name = "InstantPayoutError";
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function instantPayoutIdempotencyKey(
  consultantProfileId: string,
  now: Date = new Date(),
): string {
  const istDay = new Date(now.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  return `instant_${consultantProfileId}_${istDay}`;
}

export function nextIstMidnight(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) -
      IST_OFFSET_MS,
  );
}

export interface InstantPayoutOutcome {
  payoutId: string;
  amountPaise: number;
  awaitingApproval: boolean;
  processed: PayoutResult | null;
}

export async function createInstantPayout(
  consultantProfileId: string,
  now: Date = new Date(),
  opts?: { createdBy?: string },
): Promise<InstantPayoutOutcome> {
  if (!ENABLE_LIVE_PAYOUTS) {
    throw new InstantPayoutError(
      "PAYOUTS_DISABLED",
      "Payouts are not switched on yet.",
      503,
    );
  }
  const eligibility = await checkPayoutEligibility(consultantProfileId);
  if (eligibility.readyAmount <= 0) {
    throw new InstantPayoutError(
      "NOTHING_AVAILABLE",
      "There is nothing available to pay out right now.",
      409,
    );
  }
  if (eligibility.reason) {
    throw new InstantPayoutError(
      "PAYOUT_NOT_ELIGIBLE",
      "This account cannot receive a payout yet.",
      409,
      eligibility.reason,
    );
  }

  if (isMockRedis() || !(await checkRedisHealth())) {
    throw new CronLockUnavailableError("create-payout-batch");
  }
  const lockToken = await acquireLock(
    PAYOUT_BATCH_LOCK_KEY,
    PAYOUT_BATCH_LOCK_TTL,
  );
  if (!lockToken) {
    throw new InstantPayoutError(
      "PAYOUT_BUSY",
      "A payout run is in progress — try again in a few minutes",
      409,
    );
  }

  let minted: Awaited<ReturnType<typeof mintConsultantPayout>>;
  try {
    minted = await mintConsultantPayout({
      consultantProfileId,
      batchId: `instant_${Date.now()}_${randomUUID().slice(0, 8)}`,
      idempotencyKey: instantPayoutIdempotencyKey(consultantProfileId, now),
      kind: "INSTANT",
      createdBy: opts?.createdBy,
      autoApprove: (amount) => amount <= INSTANT_PAYOUT_AUTO_APPROVE_PAISE,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new InstantPayoutError(
        "INSTANT_ALREADY_TODAY",
        "You have already used today's instant payout. The next one opens at midnight IST.",
        409,
      );
    }
    throw error;
  } finally {
    await releaseLock(PAYOUT_BATCH_LOCK_KEY, lockToken);
  }
  if (!minted) {
    throw new InstantPayoutError(
      "NOTHING_AVAILABLE",
      "There is nothing available to pay out right now.",
      409,
    );
  }

  const awaitingApproval = minted.status !== PayoutStatus.APPROVED;
  let processed: PayoutResult | null = null;
  if (!awaitingApproval) {
    processed = await processPayoutById(minted.id).catch((error: unknown) => {
      reportSentryError(error, { subsystem: "payments", level: "warning" });
      return null;
    });
  }
  return {
    payoutId: minted.id,
    amountPaise: minted.amount,
    awaitingApproval,
    processed,
  };
}

export async function processPayoutById(
  payoutId: string,
): Promise<PayoutResult | null> {
  if (isMockRedis() || !(await checkRedisHealth())) {
    throw new CronLockUnavailableError("process-payouts");
  }
  if (!ENABLE_LIVE_PAYOUTS) return null;
  const lockToken = await acquireLock(
    PAYOUT_PROCESS_LOCK_KEY,
    PAYOUT_PROCESS_LOCK_TTL,
  );
  if (!lockToken) return null;

  try {
    const payout = await prisma.consultantPayout.findFirst({
      where: { id: payoutId, status: PayoutStatus.APPROVED },
      include: APPROVED_PAYOUT_INCLUDE,
    });
    if (!payout) return null;
    const preflight = await assertPayoutBalance(payout.amount);
    if (!preflight.ok) {
      console.warn(
        `[Payouts] Holding payout ${payoutId} — ${preflight.reason}`,
      );
      return {
        payoutId,
        success: false,
        skipped: true,
        error: preflight.reason,
      };
    }
    return await processSinglePayout(payout);
  } finally {
    await releaseLock(PAYOUT_PROCESS_LOCK_KEY, lockToken);
  }
}

export interface InstantPayoutPreview {
  readyPaise: number;
  tdsEstimatePaise: number;
  /** An earlier clawback this payout would net back; 0 when none is owed. */
  recoveryPaise: number;
  netPaise: number;
  label: string;
  nextAllowedAt: Date | null;
  reason: PayoutEligibilityReason | null;
}

export async function previewInstantPayout(
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<InstantPayoutPreview> {
  const [eligibility, usedToday, taxInfo] = await Promise.all([
    checkPayoutEligibility(consultantProfileId),
    prisma.consultantPayout.findUnique({
      where: {
        idempotencyKey: instantPayoutIdempotencyKey(consultantProfileId, now),
      },
      select: { id: true },
    }),
    prisma.consultantTaxInfo.findUnique({
      where: { consultantProfileId },
      select: { panEncrypted: true, panVerified: true, taxEntityType: true },
    }),
  ]);
  const readyPaise = Math.max(eligibility.readyAmount, 0);
  const recoveryPaise = Math.min(
    await outstandingClawbackPaise(prisma, {
      rail: "CONSULTANT",
      consultantProfileId,
    }),
    recoverablePaise(readyPaise, PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT, false),
  );
  // Same planner as processSinglePayout, so the preview matches the payout it previews.
  const plan =
    readyPaise > 0
      ? await planConsultantPayoutTds(prisma, {
          consultantProfileId,
          payoutId: null,
          netSharePaise: readyPaise,
          grossThisPayoutPaise: await earningsGrossPaise(
            prisma,
            {
              consultantProfileId,
              status: EarningStatus.READY,
              payoutId: null,
            },
            readyPaise,
          ),
          capacityPaise: readyPaise - recoveryPaise,
          financialYear: getIndianFinancialYear(now),
          cumulativeBeforePayout: await getCurrentFYCumulativePayments(
            consultantProfileId,
            getIndianFinancialYear(now),
          ),
          taxInfo,
          resolvedRate: await resolveEffectiveTdsRate(prisma, "194O", now),
          allowCatchUp: true,
        })
      : null;
  const tdsEstimatePaise = plan?.withholdPaise ?? 0;
  return {
    readyPaise,
    tdsEstimatePaise,
    recoveryPaise,
    netPaise:
      readyPaise - tdsEstimatePaise - recoveryPaise + (plan?.creditPaise ?? 0),
    label: "Free · once a day",
    nextAllowedAt: usedToday ? nextIstMidnight(now) : null,
    reason: eligibility.reason,
  };
}

type ClaimGateOutcome =
  | { kind: "dispute_blocked" }
  | { kind: "refund_blocked" }
  | { kind: "shortfall"; owedPaise: number; shortfallReason: string }
  | { kind: "already_claimed" }
  | { kind: "claimed" };

/** The claim's view of the row: its amount and the net it staged for a first send, or null. */
type ClaimTarget = { id: string; amount: number; netAmount: number | null };

async function runConsultantPayoutClaimGate(
  db: PrismaLike,
  { id: payoutId, amount, netAmount }: ClaimTarget,
): Promise<ClaimGateOutcome> {
  const disputedEarning = await db.consultantEarnings.findFirst({
    where: {
      payoutId,
      payment: DISPUTE_GATED_PAYMENT_WHERE,
    },
    select: { id: true },
  });
  if (disputedEarning) {
    return { kind: "dispute_blocked" };
  }

  const refundPendingEarning = await db.consultantEarnings.findFirst({
    where: { payoutId, payment: REFUND_GATED_PAYMENT_WHERE },
    select: { id: true },
  });
  if (refundPendingEarning) {
    return { kind: "refund_blocked" };
  }

  const owedAgg = await db.consultantEarnings.aggregate({
    where: { payoutId },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });
  const owedPaise =
    sumPaise(owedAgg._sum.consultantSharePaise) -
    sumPaise(owedAgg._sum.refundedShareAmount);
  if (owedPaise < amount) {
    const shortfallReason = `SHORTFALL_BEFORE_DISBURSEMENT: earnings owe ${owedPaise}p < batched ${amount}p`;
    const failed = await db.consultantPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.APPROVED },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: shortfallReason.slice(0, 500),
        tdsDeducted: 0,
        netAmount: null,
        tdsRateAppliedBps: null,
        tdsFinancialYear: null,
        tdsCatchUpFy: null,
        tdsCarryPaise: 0,
        tdsCreditPaise: 0,
      },
    });
    if (failed.count > 0) {
      await db.consultantEarnings.updateMany({
        where: { payoutId, status: EarningStatus.BATCHED },
        data: {
          payoutId: null,
          status: EarningStatus.READY,
          releasedFromPayoutId: payoutId,
        },
      });
      await releaseClawbackRecovery(db, payoutId);
    }
    return { kind: "shortfall", owedPaise, shortfallReason };
  }

  // The staged TDS fields, catch-up included, ride through the claim unchanged;
  // matching the read netAmount keeps a row staged since the read from being re-planned.
  const claimed = await db.consultantPayout.updateMany({
    where: { id: payoutId, status: PayoutStatus.APPROVED, netAmount },
    data: { status: PayoutStatus.PROCESSING },
  });
  if (claimed.count === 0) {
    casMiss();
    return { kind: "already_claimed" };
  }
  return { kind: "claimed" };
}

async function claimConsultantPayoutForDisbursement(
  target: ClaimTarget,
): Promise<PayoutResult | null> {
  const { id: payoutId, amount } = target;
  let claimOutcome: ClaimGateOutcome;
  try {
    claimOutcome =
      typeof prisma.$transaction === "function"
        ? await withSerializableRetry(
            () =>
              prisma.$transaction(
                (tx) => runConsultantPayoutClaimGate(tx, target),
                {
                  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                },
              ),
            1,
          )
        : await runConsultantPayoutClaimGate(prisma, target);
  } catch (err) {
    // Another payout took this FY's catch-up while this one waited APPROVED; resending
    // the staged body would withhold it twice, so the row stays APPROVED for an operator.
    if (!isTdsCatchUpRace(err)) throw err;
    const error = `TDS_CATCH_UP_TAKEN: payout ${payoutId} staged this FY's 194-O catch-up, which another live payout now holds; resend needs an operator`;
    console.warn(`[Payouts] ${error}`);
    return { payoutId, success: false, error };
  }

  if (claimOutcome.kind === "dispute_blocked") {
    console.warn(
      `[Payouts] Payout ${payoutId} blocked — an earning's payment has a live dispute`,
    );
    reportSentryMessage("Payout blocked by live dispute", {
      subsystem: "payments",
      expected: true,
      extra: { payoutId },
    });
    return { payoutId, success: false, skipped: true };
  }
  if (claimOutcome.kind === "refund_blocked") {
    console.warn(
      `[Payouts] Payout ${payoutId} blocked — an earning's payment has an uncascaded refund`,
    );
    reportSentryMessage("Payout blocked by an uncascaded refund", {
      subsystem: "payments",
      expected: true,
      extra: { payoutId },
    });
    return { payoutId, success: false, skipped: true };
  }
  if (claimOutcome.kind === "shortfall") {
    console.warn(
      `[Payouts] Payout ${payoutId} failed — ${claimOutcome.shortfallReason}`,
    );
    reportSentryMessage("payout-batch-earnings-shortfall", {
      subsystem: "payments",
      level: "error",
      extra: {
        payoutId,
        owedPaise: claimOutcome.owedPaise,
        amount,
      },
    });
    return {
      payoutId,
      success: false,
      error: claimOutcome.shortfallReason,
    };
  }
  if (claimOutcome.kind === "already_claimed") {
    console.warn(
      `[Payouts] Payout ${payoutId} already claimed by a concurrent run — skipping`,
    );
    reportSentryMessage("Payout CAS claim lost to a concurrent runner", {
      subsystem: "payments",
      expected: true,
      extra: { payoutId },
    });
    return { payoutId, success: false, skipped: true };
  }
  return null;
}

async function handleProcessSinglePayoutError(
  payoutId: string,
  error: unknown,
  providerPayoutId: string | undefined,
  submittedToGateway: boolean,
): Promise<PayoutResult> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // If the gateway already accepted the transfer, quarantine in PROCESSING with earnings linked to prevent double-disbursement.
  if (providerPayoutId) {
    try {
      await prisma.consultantPayout.updateMany({
        where: { id: payoutId, providerPayoutId: null },
        data: {
          providerPayoutId,
          failureReason:
            `Gateway accepted (${providerPayoutId}); post-submit DB write failed, awaiting reconcile: ${errorMessage}`.slice(
              0,
              500,
            ),
        },
      });
    } catch (persistErr) {
      console.error(
        `[payout-service] CRITICAL: gateway accepted ${providerPayoutId} but DB persist failed twice for payout ${payoutId}; manual reconcile required`,
        persistErr,
      );
      reportSentryError(persistErr, {
        subsystem: "payments",
        level: "fatal",
        contexts: { payout: { payoutId, providerPayoutId } },
      });
    }
    console.error(
      `⚠️ Payout ${payoutId}: gateway accepted ${providerPayoutId} but DB write failed — quarantined PROCESSING (NOT failed) to avoid double-pay`,
    );
    reportSentryError(
      new Error(`gateway-accepted-db-write-failed: payout ${payoutId}`),
      {
        subsystem: "payments",
        contexts: { payout: { payoutId, providerPayoutId } },
      },
    );
    return {
      payoutId,
      success: false,
      providerPayoutId,
      error: `gateway-accepted-db-write-failed: ${errorMessage}`,
    };
  }

  // If the request left and the error is not a definitive 4xx rejection, stay PROCESSING for reference-id reconciliation.
  if (submittedToGateway && !isDefinitiveGatewayRejection(error)) {
    try {
      await prisma.consultantPayout.updateMany({
        where: {
          id: payoutId,
          status: PayoutStatus.PROCESSING,
          providerPayoutId: null,
        },
        data: {
          failureReason:
            `Gateway outcome unknown; awaiting reconcile by reference id: ${errorMessage}`.slice(
              0,
              500,
            ),
        },
      });
    } catch (noteErr) {
      reportSentryError(noteErr, { subsystem: "payments", level: "warning" });
    }
    reportSentryError(error, {
      subsystem: "payments",
      level: "warning",
      contexts: { payout: { payoutId } },
    });
    return {
      payoutId,
      success: false,
      error: `gateway-outcome-unknown: ${errorMessage}`,
    };
  }

  // Never submitted or definitively rejected: CAS transition PROCESSING → FAILED and release BATCHED earnings back to READY.
  let stagedNotice: StagedConsultantPayoutNotice | null = null;
  await prisma.$transaction(async (tx) => {
    const failed = await tx.consultantPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PROCESSING },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: errorMessage.slice(0, 500),
        retryCount: { increment: 1 },
        tdsDeducted: 0,
        netAmount: null,
        tdsRateAppliedBps: null,
        tdsFinancialYear: null,
        tdsCatchUpFy: null,
        tdsCarryPaise: 0,
        tdsCreditPaise: 0,
      },
    });
    if (failed.count === 0) return;

    await tx.consultantEarnings.updateMany({
      where: { payoutId, status: EarningStatus.BATCHED },
      data: {
        payoutId: null,
        status: EarningStatus.READY,
        releasedFromPayoutId: payoutId,
      },
    });
    await releaseClawbackRecovery(tx, payoutId);

    const row = await tx.consultantPayout.findUnique?.({
      where: { id: payoutId },
      select: {
        amount: true,
        currency: true,
        method: true,
        consultantProfileId: true,
      },
    });
    if (row) {
      stagedNotice = await stageConsultantPayoutNotice(tx, {
        consultantProfileId: row.consultantProfileId,
        payoutId,
        status: "FAILED",
        amountPaise: Number(row.amount),
        currency: row.currency,
        method: row.method,
        reason: errorMessage.slice(0, 500),
      });
    }
  });

  await flushConsultantPayoutNotice(stagedNotice);

  return {
    payoutId,
    success: false,
    error: errorMessage,
  };
}

/** Plans the payout's TDS and stages it on the PROCESSING row; null when the row left PROCESSING first. */
async function planAndStageConsultantTds(
  payout: { id: string; consultantProfileId: string; amount: number },
  consultantTaxInfo: ConsultantTdsInput["taxInfo"],
): Promise<number | null> {
  const financialYear = getIndianFinancialYear();
  const cumulativeBeforePayout = await getCurrentFYCumulativePayments(
    payout.consultantProfileId,
    financialYear,
  );
  const recoveredPaise = await clawbackRecoveredPaise(prisma, payout.id);
  if (payout.amount - recoveredPaise <= 0) {
    throw new Error(
      `Payout ${payout.id} nets to ${payout.amount - recoveredPaise} paise after clawback recovery`,
    );
  }
  const tdsInput: ConsultantTdsInput = {
    consultantProfileId: payout.consultantProfileId,
    payoutId: payout.id,
    netSharePaise: payout.amount,
    grossThisPayoutPaise: await earningsGrossPaise(
      prisma,
      { payoutId: payout.id },
      payout.amount,
    ),
    capacityPaise: payout.amount - recoveredPaise,
    financialYear,
    cumulativeBeforePayout,
    taxInfo: consultantTaxInfo,
    resolvedRate: await resolveEffectiveTdsRate(prisma, "194O", new Date()),
    allowCatchUp: true,
  };
  let plan = await planConsultantPayoutTds(prisma, tdsInput);
  const netAfter = (p: ConsultantTdsPlan) =>
    payout.amount - recoveredPaise - p.withholdPaise + p.creditPaise;

  // Stage TDS fields before gateway submission so an immediate completion webhook posts the net cash leg.
  const stage = (p: ConsultantTdsPlan) =>
    prisma.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.PROCESSING },
      data: {
        tdsDeducted: p.withholdPaise,
        netAmount: netAfter(p),
        tdsRateAppliedBps: p.rateAppliedBps,
        tdsFinancialYear: financialYear,
        tdsCatchUpFy: p.catchUpFy,
        tdsCarryPaise: p.carryPaise,
        tdsCreditPaise: p.creditPaise,
      },
    });
  let staged: Prisma.BatchPayload;
  try {
    staged = await stage(plan);
  } catch (err) {
    // The database allows one catch-up per expert per FY; the loser pays on its own gross.
    if (!plan.catchUpFy || !isTdsCatchUpRace(err)) throw err;
    plan = await planConsultantPayoutTds(prisma, {
      ...tdsInput,
      allowCatchUp: false,
    });
    staged = await stage(plan);
  }
  const payoutAmountAfterTDS = netAfter(plan);

  if (plan.withholdPaise > 0 || plan.creditPaise > 0 || plan.carryPaise !== 0) {
    console.log(
      JSON.stringify({
        event: "tds_deduction",
        payoutId: payout.id,
        consultantProfileId: payout.consultantProfileId,
        grossAmount: tdsInput.grossThisPayoutPaise,
        taxableAmount: plan.taxablePaise,
        cumulativeBeforePayout,
        tdsAmount: plan.withholdPaise,
        tdsCreditPaise: plan.creditPaise,
        tdsCarryPaise: plan.carryPaise,
        tdsCatchUpFy: plan.catchUpFy,
        tdsRateAppliedBps: plan.rateAppliedBps,
        tdsSection: plan.tdsSection,
        netAmount: payoutAmountAfterTDS,
        financialYear,
        reason: plan.reason,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return staged.count === 0 ? null : payoutAmountAfterTDS;
}

async function processSinglePayout(payout: {
  id: string;
  consultantProfileId: string;
  provider: PaymentGateway;
  amount: number;
  currency: string;
  method: PayoutMethod;
  idempotencyKey: string | null;
  netAmount: number | null;
  payoutAccount: PayoutDestination | null;
  consultantProfile: {
    payoutAccounts?: PayoutDestination[];
    user: {
      name: string | null;
      email: string | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}): Promise<PayoutResult> {
  let providerPayoutId: string | undefined;
  let submittedToGateway = false;
  const markSubmitted = () => {
    submittedToGateway = true;
  };
  try {
    const blockedResult = await claimConsultantPayoutForDisbursement(payout);
    if (blockedResult) {
      return blockedResult;
    }

    const account = payableDestination(payout);
    if (!account) {
      throw new Error(
        "The payout's account is missing, unverified, frozen or cooling off",
      );
    }

    const consultantTaxInfo = await prisma.consultantTaxInfo.findUnique({
      where: { consultantProfileId: payout.consultantProfileId },
    });
    if (consultantTaxInfo && !consultantTaxInfo.isIndianResident) {
      throw new Error(
        "Payouts to non-resident consultants are not supported yet (Section 195 TDS not implemented). " +
          `Consultant: ${payout.consultantProfileId}. Please process this payout manually.`,
      );
    }

    // A row staged by an earlier attempt resends that attempt's amount under the same key.
    const payoutAmountAfterTDS =
      payout.netAmount ??
      (await planAndStageConsultantTds(payout, consultantTaxInfo));

    if (payoutAmountAfterTDS === null) {
      console.warn(
        `[Payouts] Payout ${payout.id} left PROCESSING before submission — skipping`,
      );
      reportSentryMessage("Claimed payout moved before gateway submission", {
        subsystem: "payments",
        level: "warning",
        extra: { payoutId: payout.id },
      });
      return { payoutId: payout.id, success: false, skipped: true };
    }

    if (payoutAmountAfterTDS === 0) {
      await completeZeroCashConsultantPayout(payout.id);
      return { payoutId: payout.id, success: true };
    }

    const payoutForGateway = { ...payout, amount: payoutAmountAfterTDS };

    if (payout.provider === PaymentGateway.RAZORPAY) {
      providerPayoutId = await processRazorpayPayout(
        payoutForGateway,
        account,
        markSubmitted,
      );
    } else {
      throw new Error(`Unsupported provider: ${payout.provider}`);
    }

    await prisma.consultantPayout.updateMany({
      where: { id: payout.id, providerPayoutId: null },
      data: { providerPayoutId },
    });

    return {
      payoutId: payout.id,
      success: true,
      providerPayoutId,
    };
  } catch (error) {
    return handleProcessSinglePayoutError(
      payout.id,
      error,
      providerPayoutId,
      submittedToGateway,
    );
  }
}

async function processRazorpayPayout(
  payout: {
    id: string;
    amount: number;
    currency: string;
    method: PayoutMethod;
    idempotencyKey: string | null;
  },
  account: {
    razorpayFundAccId: string | null;
    accountType: string;
  },
  onSubmit: () => void,
): Promise<string> {
  if (!isRazorpayPayoutsConfigured()) {
    throw new Error("RazorpayX Payouts not configured");
  }

  if (payout.currency !== "INR") {
    throw new Error(
      `Razorpay payouts only support INR. Got: ${payout.currency}. ` +
        `International payouts require manual processing for MVP.`,
    );
  }

  if (!account.razorpayFundAccId) {
    throw new Error("Razorpay fund account not found");
  }

  const razorpayPayouts = getRazorpayPayoutsService();
  const mode = razorpayPayouts.determinePayoutMode(
    payout.amount,
    account.accountType === "UPI" ? "vpa" : "bank_account",
  );

  onSubmit();
  const result = await razorpayPayouts.createPayout({
    fundAccountId: account.razorpayFundAccId,
    amount: payout.amount,
    currency: payout.currency,
    mode,
    purpose: "payout",
    queueIfLowBalance: true,
    referenceId: payout.id,
    idempotencyKey:
      payout.idempotencyKey ||
      razorpayPayouts.generateIdempotencyKey(payout.id),
    notes: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return result.id;
}

export async function reportUnknownPayoutStatus(input: {
  provider: PaymentGateway;
  providerPayoutId: string;
  status: string;
  eventType?: string;
}): Promise<void> {
  Sentry.addBreadcrumb({
    category: "payouts",
    level: "warning",
    message: `Unknown ${input.provider} payout status "${input.status}"`,
    data: input,
  });
  await recordSystemEvent({
    category: "PAYOUT",
    severity: "WARN",
    message: `Unknown ${input.provider} payout status "${input.status}" for ${input.providerPayoutId}; status left unchanged`,
    context: input,
  });
}

function mapWebhookPayoutStatus(status: string): PayoutStatus | null {
  switch (status) {
    case "COMPLETED":
      return PayoutStatus.COMPLETED;
    case "FAILED":
      return PayoutStatus.FAILED;
    case "CANCELLED":
      return PayoutStatus.CANCELLED;
    case "PROCESSING":
      return PayoutStatus.PROCESSING;
    case "PENDING":
      return PayoutStatus.PENDING;
    default:
      return null;
  }
}

async function loadCompletionEarningsForShortfall(
  tx: Tx,
  payoutId: string,
  fallbackEarnings: unknown,
): Promise<
  Array<{ consultantSharePaise: number; refundedShareAmount?: number | null }>
> {
  if (typeof tx.consultantEarnings.findMany === "function") {
    return await tx.consultantEarnings.findMany({
      where: { payoutId },
      select: {
        consultantSharePaise: true,
        refundedShareAmount: true,
      },
    });
  }
  if (
    Array.isArray(fallbackEarnings) &&
    fallbackEarnings.length > 0 &&
    typeof (fallbackEarnings[0] as { consultantSharePaise?: unknown })
      ?.consultantSharePaise === "number"
  ) {
    return fallbackEarnings as Array<{
      consultantSharePaise: number;
      refundedShareAmount?: number | null;
    }>;
  }
  return [];
}

function isTdsCatchUpRace(err: unknown): boolean {
  return (
    isUniqueViolationOn(err, "tdsCatchUpFy") ||
    isUniqueViolationOn(err, "consultant_payout_one_tds_catch_up_per_fy")
  );
}

/** A payout whose TDS absorbs all of it moves no cash, so it completes here instead of at the gateway. */
async function completeZeroCashConsultantPayout(
  payoutId: string,
): Promise<void> {
  let stagedNotice: StagedConsultantPayoutNotice | null = null;
  await withSerializableRetry(() => {
    stagedNotice = null;
    return prisma.$transaction(
      async (tx) => {
        const { count } = await tx.consultantPayout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: { status: PayoutStatus.COMPLETED, processedAt: new Date() },
        });
        if (count === 0) return;
        const row = await tx.consultantPayout.findUniqueOrThrow({
          where: { id: payoutId },
          include: { earnings: true },
        });
        await completeConsultantPayoutInTx(tx, row);
        stagedNotice = await stageConsultantPayoutNotice(tx, {
          consultantProfileId: row.consultantProfileId,
          payoutId,
          status: "COMPLETED",
          amountPaise: row.amount,
          currency: row.currency,
          method: row.method,
          withheldText: formatNotificationMoney(row.tdsDeducted, row.currency),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
  await flushConsultantPayoutNotice(stagedNotice);
}

async function completeConsultantPayoutInTx(
  tx: Tx,
  matched: {
    id: string;
    consultantProfileId: string;
    amount: number;
    tdsDeducted: number;
    tdsRateAppliedBps: number | null;
    tdsCreditPaise?: number;
    earnings?: unknown;
  },
): Promise<void> {
  const { financialYear, quarter, start, end } = resolveCompletionTdsWindow();
  const creditPaise = matched.tdsCreditPaise ?? 0;
  const previousCompletedPayouts = await tx.consultantPayout.aggregate({
    where: {
      consultantProfileId: matched.consultantProfileId,
      status: PayoutStatus.COMPLETED,
      processedAt: { gte: start, lt: end },
      id: { not: matched.id },
    },
    _sum: { amount: true },
  });
  const cumulativeCreditedPayments =
    sumPaise(previousCompletedPayouts._sum.amount) + matched.amount;

  await tx.consultantEarnings.updateMany({
    where: { payoutId: matched.id, status: EarningStatus.BATCHED },
    data: {
      status: EarningStatus.PAID,
      paidAt: new Date(),
    },
  });

  // #1898 — Re-verify sum(consultantSharePaise - refundedShareAmount) across
  // the batch's earnings at completion time. If a late refund cascaded while
  // the payout was in flight at the gateway, accrue the shortfall into
  // clawbackAmountPaise and emit a WARN SystemEvent.
  const completionEarnings = await loadCompletionEarningsForShortfall(
    tx,
    matched.id,
    matched.earnings,
  );
  const loaderAvailable =
    typeof tx.consultantEarnings.findMany === "function" ||
    completionEarnings.length > 0;
  let shortfallPaise = 0;
  if (loaderAvailable) {
    const owedPaise = completionEarnings.reduce(
      (sum, e) =>
        sum +
        Math.max(0, e.consultantSharePaise - (e.refundedShareAmount ?? 0)),
      0,
    );
    if (owedPaise < matched.amount) {
      shortfallPaise = matched.amount - owedPaise;
      if (typeof tx.consultantPayout.update === "function") {
        await tx.consultantPayout.update({
          where: { id: matched.id },
          data: { clawbackAmountPaise: { increment: shortfallPaise } },
        });
      } else {
        await tx.consultantPayout.updateMany({
          where: { id: matched.id },
          data: { clawbackAmountPaise: { increment: shortfallPaise } },
        });
      }
      await postConsultantPayoutClawback(tx, {
        refundId: `shortfall:${matched.id}`,
        consultantPayoutId: matched.id,
        consultantProfileId: matched.consultantProfileId,
        amountPaise: shortfallPaise,
        reason: "in-flight refund shortfall at payout completion",
      });
      await recordSystemEventSafe({
        db: tx,
        category: "PAYOUT",
        severity: "WARN",
        message: `PAYOUT_COMPLETION_EARNINGS_SHORTFALL: payout ${matched.id} completed for ${matched.amount}p while earnings owe ${owedPaise}p (clawback +${shortfallPaise}p)`,
        context: {
          payoutId: matched.id,
          consultantProfileId: matched.consultantProfileId,
          disbursedPaise: matched.amount,
          owedPaise,
          shortfallPaise,
        },
      });
    }
  }

  // The recovered slice already left the payable when the payout was built.
  const recoveredPaise = await clawbackRecoveredPaise(tx, matched.id);
  if (matched.amount - recoveredPaise > 0) {
    const tdsPaise = (matched.tdsDeducted ?? 0) - creditPaise;
    const cashPaise = matched.amount - tdsPaise - recoveredPaise;
    await postLedgerTxn(tx, {
      idempotencyKey: `payout:${matched.id}`,
      kind: "PAYOUT",
      payoutId: matched.id,
      postings: buildPayoutCompletionPostings({
        payableAccount: {
          kind: "CONSULTANT_PAYABLE",
          consultantProfileId: matched.consultantProfileId,
        },
        grossPayablePaise: matched.amount - recoveredPaise,
        netCashPaise: cashPaise,
        tdsPaise,
      }),
    });
  }

  // Excess FY TDS returned on this payout files as a negative record, like a refund reversal.
  if (creditPaise > 0) {
    await tx.tDSRecord.deleteMany({
      where: { payoutId: matched.id, isReversal: true },
    });
    const credit = await tx.tDSRecord.create({
      data: {
        consultantProfileId: matched.consultantProfileId,
        financialYear,
        quarter,
        cumulativeAmountCredited: cumulativeCreditedPayments,
        tdsDeducted: -creditPaise,
        tdsRateBps: matched.tdsRateAppliedBps ?? 0,
        tdsSection: "194O",
        payoutId: matched.id,
        isReversal: true,
      },
    });
    await tx.tdsAdjustment.create({
      data: {
        consultantProfileId: matched.consultantProfileId,
        tdsRecordId: credit.id,
        payoutId: matched.id,
        financialYear,
        quarter,
        amountPaise: -creditPaise,
        reason:
          "194-O threshold credit — FY gross fell back to ₹5L or below after refunds",
      },
    });
  }

  if (matched.tdsDeducted > 0 && matched.tdsRateAppliedBps) {
    await tx.tDSRecord.deleteMany({
      where: { payoutId: matched.id, isReversal: false },
    });

    await recordTDSDeduction({
      consultantProfileId: matched.consultantProfileId,
      financialYear,
      quarter,
      tdsDeducted: matched.tdsDeducted,
      tdsRateBps: matched.tdsRateAppliedBps,
      cumulativeAmountCredited: cumulativeCreditedPayments,
      payoutId: matched.id,
      tdsSection: "194O",
      db: tx,
    });
  }
}

async function failOrCancelConsultantPayoutInTx(
  tx: Tx,
  payoutId: string,
): Promise<void> {
  await tx.consultantEarnings.updateMany({
    where: { payoutId, status: EarningStatus.BATCHED },
    data: {
      payoutId: null,
      status: EarningStatus.READY,
      releasedFromPayoutId: payoutId,
    },
  });

  await tx.tDSRecord.deleteMany({
    where: { payoutId },
  });

  await tx.consultantPayout.update({
    where: { id: payoutId },
    data: {
      tdsDeducted: 0,
      netAmount: null,
      tdsRateAppliedBps: null,
      tdsFinancialYear: null,
      tdsCatchUpFy: null,
      tdsCarryPaise: 0,
      tdsCreditPaise: 0,
    },
  });

  await releaseClawbackRecovery(tx, payoutId);
}

/**
 * The gateway paid a payout we had already failed and released: re-attach the
 * earnings still READY under it, and the completion shortfall claws back the rest.
 */
async function completeLocallyFailedPayoutInTx(
  tx: Tx,
  input: {
    payoutId: string;
    providerPayoutId: string;
    gatewayUtr?: string;
    stampProviderId: boolean;
  },
): Promise<StagedConsultantPayoutNotice | null> {
  const { payoutId, providerPayoutId } = input;
  const { count } = await tx.consultantPayout.updateMany({
    where: {
      id: payoutId,
      status: PayoutStatus.FAILED,
      ...(input.stampProviderId ? { providerPayoutId: null } : {}),
    },
    data: {
      status: PayoutStatus.COMPLETED,
      processedAt: new Date(),
      ...(input.gatewayUtr ? { gatewayUtr: input.gatewayUtr } : {}),
      ...(input.stampProviderId ? { providerPayoutId } : {}),
    },
  });
  if (count === 0) return null;

  const reattached = await tx.consultantEarnings.updateMany({
    where: {
      releasedFromPayoutId: payoutId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    data: { payoutId, status: EarningStatus.BATCHED },
  });
  const row = await tx.consultantPayout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { earnings: true },
  });
  const reattachedPaise = row.earnings.reduce(
    (s, e) => s + Math.max(0, e.consultantSharePaise - e.refundedShareAmount),
    0,
  );
  await completeConsultantPayoutInTx(tx, row);

  const context = {
    payoutId,
    providerPayoutId,
    reattachedEarnings: reattached.count,
    clawbackPaise: Math.max(0, row.amount - reattachedPaise),
    note: "TDS and clawback recovery staged at submission were cleared on failure; check the cash leg against the gateway amount",
  };
  await recordSystemEventSafe({
    db: tx,
    category: "PAYOUT",
    severity: "ERROR",
    message: `PAYOUT_COMPLETED_AFTER_LOCAL_FAILED: gateway processed ${providerPayoutId} for payout ${payoutId} already marked FAILED; re-attached ${reattached.count} earning(s), clawback ${context.clawbackPaise}p`,
    context,
  });
  reportSentryMessage("PAYOUT_COMPLETED_AFTER_LOCAL_FAILED", {
    subsystem: "payments",
    level: "error",
    extra: context,
  });

  return stageConsultantPayoutNotice(tx, {
    consultantProfileId: row.consultantProfileId,
    payoutId,
    status: "COMPLETED",
    amountPaise: row.amount,
    currency: row.currency,
    method: row.method,
  });
}

export async function handlePayoutWebhook(
  _provider: PaymentGateway,
  providerPayoutId: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED",
  failureReason?: string,
  gatewayUtr?: string,
  referenceId?: string,
): Promise<void> {
  let payout = await prisma.consultantPayout.findFirst({
    where: { providerPayoutId },
    include: { earnings: true },
  });
  let stampProviderId = false;
  if (!payout && referenceId) {
    payout = await prisma.consultantPayout.findFirst({
      where: { id: referenceId, provider: _provider, providerPayoutId: null },
      include: { earnings: true },
    });
    stampProviderId = payout !== null;
  }

  if (!payout) {
    await recordSystemEvent({
      category: "PAYOUT",
      severity:
        status === "PENDING" || status === "PROCESSING" ? "WARN" : "ERROR",
      message: `Payout webhook ${status} matched no consultant payout (provider id ${providerPayoutId}, reference ${referenceId ?? "none"})`,
      context: { provider: _provider, providerPayoutId, referenceId, status },
    });
    reportSentryMessage("Payout webhook matched no consultant payout", {
      subsystem: "payments",
      level: "warning",
      extra: { providerPayoutId, referenceId, status },
    });
    return;
  }
  const matched = payout;

  const payoutStatus = mapWebhookPayoutStatus(status);
  if (!payoutStatus) {
    await reportUnknownPayoutStatus({
      provider: _provider,
      providerPayoutId,
      status: String(status),
    });
    return;
  }

  const stampWhere = stampProviderId ? { providerPayoutId: null } : {};
  const stampData = stampProviderId ? { providerPayoutId } : {};

  async function backfillCompletedPayoutUtr(tx: Tx): Promise<void> {
    if (!gatewayUtr) return;
    await tx.consultantPayout.updateMany({
      where: {
        id: matched.id,
        status: PayoutStatus.COMPLETED,
        gatewayUtr: null,
      },
      data: { gatewayUtr },
    });
  }

  let stagedNotice: StagedConsultantPayoutNotice | null = null;
  await withSerializableRetry(() => {
    stagedNotice = null;
    return prisma.$transaction(
      async (tx) => {
        const terminalIncoming =
          payoutStatus === PayoutStatus.COMPLETED ||
          payoutStatus === PayoutStatus.FAILED ||
          payoutStatus === PayoutStatus.CANCELLED;
        const excludedStatuses: PayoutStatus[] = [
          PayoutStatus.COMPLETED,
          PayoutStatus.CANCELLED,
          PayoutStatus.REVERSED,
          PayoutStatus.FAILED,
        ];
        const { count } = await tx.consultantPayout.updateMany({
          where: {
            id: matched.id,
            ...stampWhere,
            status: terminalIncoming
              ? {
                  notIn: excludedStatuses,
                }
              : { in: [PayoutStatus.PROCESSING] },
          },
          data: {
            status: terminalIncoming ? payoutStatus : PayoutStatus.PROCESSING,
            processedAt:
              payoutStatus === PayoutStatus.COMPLETED ? new Date() : undefined,
            failureReason: failureReason,
            gatewayUtr:
              payoutStatus === PayoutStatus.COMPLETED && gatewayUtr
                ? gatewayUtr
                : undefined,
            ...stampData,
          },
        });

        if (count === 0) {
          if (payoutStatus === PayoutStatus.COMPLETED) {
            await backfillCompletedPayoutUtr(tx);
            const current =
              (await tx.consultantPayout.findFirst({
                where: { id: matched.id },
                select: { status: true },
              })) ?? matched;
            if (current.status === PayoutStatus.FAILED) {
              stagedNotice = await completeLocallyFailedPayoutInTx(tx, {
                payoutId: matched.id,
                providerPayoutId,
                gatewayUtr,
                stampProviderId,
              });
              return stagedNotice !== null;
            }
          }
          console.log(
            `Payout ${matched.id} already in terminal state, skipping duplicate ${status} webhook`,
          );
          reportSentryMessage("Payout webhook idempotency short-circuit", {
            subsystem: "payments",
            expected: true,
            extra: { payoutId: matched.id, status },
          });
          return false;
        }

        if (payoutStatus === PayoutStatus.COMPLETED) {
          await completeConsultantPayoutInTx(tx, matched);
          stagedNotice = await stageConsultantPayoutNotice(tx, {
            consultantProfileId: matched.consultantProfileId,
            payoutId: matched.id,
            status: "COMPLETED",
            amountPaise: Number(matched.amount),
            currency: matched.currency,
            method: matched.method,
            ...(matched.tdsDeducted > 0
              ? {
                  withheldText: formatNotificationMoney(
                    matched.tdsDeducted,
                    matched.currency,
                  ),
                }
              : {}),
          });
          return true;
        }

        if (
          payoutStatus === PayoutStatus.FAILED ||
          payoutStatus === PayoutStatus.CANCELLED
        ) {
          await failOrCancelConsultantPayoutInTx(tx, matched.id);
          stagedNotice = await stageConsultantPayoutNotice(tx, {
            consultantProfileId: matched.consultantProfileId,
            payoutId: matched.id,
            status: "FAILED",
            amountPaise: Number(matched.amount),
            currency: matched.currency,
            method: matched.method,
            reason: failureReason,
          });
        }
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  await flushConsultantPayoutNotice(stagedNotice);
}

export async function markConsultantPayoutReversed(
  providerPayoutId: string,
  reason: string,
  referenceId?: string,
): Promise<{ wasNoOp: boolean }> {
  let stagedNotice: StagedConsultantPayoutNotice | null = null;
  const result = await withSerializableRetry(() => {
    stagedNotice = null;
    return prisma.$transaction(
      async (tx) => {
        const selectShape = {
          id: true,
          consultantProfileId: true,
          amount: true,
          tdsDeducted: true,
          tdsCreditPaise: true,
          tdsRateAppliedBps: true,
          tdsFinancialYear: true,
          currency: true,
          method: true,
        } as const;
        let payout = await tx.consultantPayout.findFirst({
          where: { providerPayoutId },
          select: selectShape,
        });
        let stampProviderId = false;
        if (!payout && referenceId) {
          payout = await tx.consultantPayout.findFirst({
            where: { id: referenceId, providerPayoutId: null },
            select: selectShape,
          });
          if (payout) {
            stampProviderId = true;
          }
        }
        if (!payout) {
          console.warn(
            `[payouts] markConsultantPayoutReversed: payout not found for provider ID ${providerPayoutId}`,
          );
          reportSentryMessage(
            "markConsultantPayoutReversed: payout not found for provider ID",
            {
              subsystem: "payments",
              level: "warning",
              extra: { providerPayoutId, referenceId },
            },
          );
          return { wasNoOp: true };
        }

        const stampWhere = stampProviderId ? { providerPayoutId: null } : {};
        const stampData = stampProviderId ? { providerPayoutId } : {};

        // 1. Post-settlement reversal (COMPLETED → REVERSED): post inverse journal and reopen PAID → READY.
        const claimCompleted = await tx.consultantPayout.updateMany({
          where: {
            id: payout.id,
            status: PayoutStatus.COMPLETED,
            ...stampWhere,
          },
          data: {
            status: PayoutStatus.REVERSED,
            failureReason: reason.slice(0, 500),
            ...stampData,
          },
        });
        if (claimCompleted.count > 0) {
          await tx.consultantEarnings.updateMany({
            where: { payoutId: payout.id, status: EarningStatus.PAID },
            data: {
              status: EarningStatus.READY,
              payoutId: null,
              paidAt: null,
            },
          });

          const recoveredPaise = await clawbackRecoveredPaise(tx, payout.id);
          if (payout.amount - recoveredPaise > 0) {
            const tdsPaise =
              (payout.tdsDeducted ?? 0) - (payout.tdsCreditPaise ?? 0);
            const cashPaise = payout.amount - tdsPaise - recoveredPaise;
            await postLedgerTxn(tx, {
              idempotencyKey: `payout-reversal:${payout.id}`,
              kind: "PAYOUT",
              payoutId: payout.id,
              postings: buildPayoutReversalPostings({
                payableAccount: {
                  kind: "CONSULTANT_PAYABLE",
                  consultantProfileId: payout.consultantProfileId,
                },
                grossPayablePaise: payout.amount - recoveredPaise,
                netCashPaise: cashPaise,
                tdsPaise,
              }),
            });
          }

          if ((payout.tdsDeducted ?? 0) > 0 && tx.tDSRecord) {
            await recordTdsReversal(tx, {
              payoutId: payout.id,
              consultantProfileId: payout.consultantProfileId,
              refundAmountPaise: payout.amount,
              paymentAmountPaise: payout.amount,
            });
          }
          // A returned credit payout re-owes the credited TDS; the next payout recomputes it.
          if ((payout.tdsCreditPaise ?? 0) > 0) {
            await recordTDSDeduction({
              consultantProfileId: payout.consultantProfileId,
              financialYear: getIndianFinancialYear(),
              tdsDeducted: payout.tdsCreditPaise,
              tdsRateBps: payout.tdsRateAppliedBps ?? 0,
              cumulativeAmountCredited: 0,
              payoutId: payout.id,
              tdsSection: "194O",
              db: tx,
            });
          }

          await releaseClawbackRecovery(tx, payout.id);
          const voided = await voidClawbacksRaisedOnPayout(tx, {
            payoutId: payout.id,
            consultantProfileId: payout.consultantProfileId,
          });
          if (voided.alreadyRecoveredPaise > 0) {
            await recordSystemEventSafe({
              db: tx,
              category: "PAYOUT",
              severity: "ERROR",
              message: `PAYOUT_REVERSED_CLAWBACK_ALREADY_RECOVERED: payout ${payout.id} was reversed after ${voided.alreadyRecoveredPaise}p of the clawbacks raised on it had been recovered from later payouts; that sum is owed back to the consultant`,
              context: {
                payoutId: payout.id,
                consultantProfileId: payout.consultantProfileId,
                ...voided,
              },
            });
          }

          stagedNotice = await stageConsultantPayoutNotice(tx, {
            consultantProfileId: payout.consultantProfileId,
            payoutId: payout.id,
            status: "REVERSED",
            amountPaise: Number(payout.amount),
            currency: payout.currency,
            method: payout.method,
            reason,
          });

          console.log(
            `↩️  Consultant payout ${payout.id} reversed after completion (provider=${providerPayoutId}): ${reason.slice(0, 200)}`,
          );

          return { wasNoOp: false };
        }

        // 2. Pre-settlement reversal ([PENDING, PROCESSING] → REVERSED): detach BATCHED → READY without inverse journal.
        const claimPreSettlement = await tx.consultantPayout.updateMany({
          where: {
            id: payout.id,
            status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
            ...stampWhere,
          },
          data: {
            status: PayoutStatus.REVERSED,
            failureReason: reason.slice(0, 500),
            ...stampData,
          },
        });
        if (claimPreSettlement.count > 0) {
          await failOrCancelConsultantPayoutInTx(tx, payout.id);
          stagedNotice = await stageConsultantPayoutNotice(tx, {
            consultantProfileId: payout.consultantProfileId,
            payoutId: payout.id,
            status: "REVERSED",
            amountPaise: Number(payout.amount),
            currency: payout.currency,
            method: payout.method,
            reason,
          });
          console.log(
            `↩️  Consultant payout ${payout.id} reversed prior to completion (provider=${providerPayoutId}): ${reason.slice(0, 200)}`,
          );
          return { wasNoOp: false };
        }

        reportSentryMessage("markConsultantPayoutReversed: no-op (terminal)", {
          subsystem: "payments",
          expected: true,
          extra: { payoutId: payout.id },
        });
        return { wasNoOp: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  await flushConsultantPayoutNotice(stagedNotice);

  return { wasNoOp: result.wasNoOp };
}

export async function getPayoutStats() {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.COMPLETED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.FAILED },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    pending: {
      count: pending._count,
      amount: sumPaise(pending._sum.amount),
    },
    processing: {
      count: processing._count,
      amount: sumPaise(processing._sum.amount),
    },
    completed: {
      count: completed._count,
      amount: sumPaise(completed._sum.amount),
    },
    failed: {
      count: failed._count,
      amount: sumPaise(failed._sum.amount),
    },
  };
}

/** Consultant-safe payout projection excluding internal gateway and dedupe identifiers. */
export const CONSULTANT_PAYOUT_SELECT = {
  id: true,
  status: true,
  amount: true,
  tdsDeducted: true,
  netAmount: true,
  tdsRateAppliedBps: true,
  tdsFinancialYear: true,
  processedAt: true,
  gatewayUtr: true,
  failureReason: true,
  mustPayByDate: true,
  createdAt: true,
} as const;

export async function getConsultantPayouts(
  consultantProfileId: string,
  options: { take?: number } = {},
) {
  const { take = 50 } = options;
  return prisma.consultantPayout.findMany({
    where: { consultantProfileId },
    select: CONSULTANT_PAYOUT_SELECT,
    orderBy: { createdAt: "desc" },
    take,
  });
}

export type ConsultantPayoutRow = Awaited<
  ReturnType<typeof getConsultantPayouts>
>[number];
