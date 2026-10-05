/**
 * Payout Service
 * Provider-agnostic consultant payout orchestration with admin approval workflow.
 */

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
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Refusal } from "@/lib/errors/refusal";
import {
  INSTANT_PAYOUT_AUTO_APPROVE_PAISE,
  PAYOUT_CONSTANTS,
} from "./constants";
import {
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
} from "./clawback-recovery";
import { postConsultantPayoutClawback } from "@/lib/payments/operations/reversal-engine";
import { randomUUID } from "crypto";
import {
  acquireLock,
  releaseLock,
  isMockRedis,
  checkRedisHealth,
} from "@/lib/redis";
import { CronLockUnavailableError } from "@/lib/cron/with-cron-lock";
import { assertPayoutBalance } from "./balance-preflight";
import {
  ENABLE_LIVE_PAYOUTS,
  ENABLE_TDS_194O_GROSS,
} from "@/lib/feature-flags";
import { resolveEffectiveTdsRate } from "@/lib/compliance/tds";
import {
  getCurrentFYCumulativePayments,
  getFYDateRange,
  getIndianFinancialYear,
  recordTDSDeduction,
  resolve194OTaxablePaise,
  TDS_THRESHOLD_PAISE,
} from "@/lib/payments/tax/tds-service";
import { notifyPayoutFailed, notifyPayoutProcessed } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  buildPayoutCompletionPostings,
  buildPayoutReversalPostings,
  computeResidentPayoutTds,
  DISPUTE_GATED_PAYMENT_WHERE,
  PayoutMakerCheckerError,
  REFUND_GATED_PAYMENT_WHERE,
  resolveCompletionTdsWindow,
  resolvePayoutMsmeDeadline,
  tdsRateToBps,
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
    select: { id: true, provider: true, isVerified: true },
  });
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
    select: { isIndianResident: true },
  });
  const verifiedAccount = defaultAccount?.isVerified ? defaultAccount : null;

  const reason = payoutEligibilityReason({
    livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    isIndianResident: taxInfo?.isIndianResident ?? true,
    defaultAccount,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
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

export async function createPayoutBatch(
  consultantProfileIds?: string[],
  opts?: { createdBy?: string },
): Promise<string> {
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
    throw new Error(
      "Payout batch creation is already in progress. Please wait and try again.",
    );
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
      },
      orderBy: { consultantProfileId: "asc" },
      _sum: { consultantSharePaise: true },
      having: {
        consultantSharePaise: {
          _sum: { gte: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT },
        },
      },
    });

    for (const { consultantProfileId } of eligibleConsultants) {
      await mintConsultantPayout({
        consultantProfileId,
        batchId,
        idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
        createdBy: opts?.createdBy ?? "SYSTEM_CRON",
        autoApprove: (amount) =>
          amount < PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD,
      });
    }

    return batchId;
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

  return prisma.$transaction(async (tx) => {
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
  });
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
        typeof (prisma as { user?: { count?: (args: unknown) => Promise<number> } })
          .user?.count === "function"
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

export async function rejectPayout(
  payoutId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.consultantPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PENDING },
      data: {
        status: PayoutStatus.CANCELLED,
        failureReason: reason,
      },
    });
    if (claimed.count === 0) {
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
  });

  try {
    const rejected = await prisma.consultantPayout.findUnique({
      where: { id: payoutId },
      select: {
        amount: true,
        currency: true,
        consultantProfile: { select: { userId: true } },
      },
    });
    const userId = rejected?.consultantProfile?.userId;
    if (rejected && userId) {
      await notifyPayoutFailed(userId, {
        amount: Number(rejected.amount),
        currency: rejected.currency,
        payoutId,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "earnings")}`,
      });
    }
  } catch (error) {
    console.error("[payouts] Failed to send payout-rejected notice:", error);
    reportSentryError(error, { subsystem: "payments", level: "warning" });
  }
}

const PAYOUT_PROCESS_LOCK_KEY = "lock:payout_processing";
const PAYOUT_PROCESS_LOCK_TTL = 35 * 60_000;

const APPROVED_PAYOUT_INCLUDE = {
  consultantProfile: {
    include: {
      payoutAccounts: { where: { isDefault: true, isVerified: true } },
      user: true,
    },
  },
} satisfies Prisma.ConsultantPayoutInclude;

/** Execution bounds for an on-demand request run within Lambda timeout limits. */
export const REQUEST_PAYOUT_RUN_BOUNDS = {
  budgetMs: 20_000,
  lockTtlMs: 2 * 60_000,
} as const;

export async function processApprovedPayouts(
  opts: {
    budgetMs?: number;
    lockTtlMs?: number;
    triggeredByUserId?: string;
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
      where: {
        status: PayoutStatus.APPROVED,
        retryCount: { lt: PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS },
      },
      include: APPROVED_PAYOUT_INCLUDE,
    });

    const batchTotalPaise = approvedPayouts.reduce((s, p) => s + p.amount, 0);
    const preflight = await assertPayoutBalance(batchTotalPaise);
    if (!preflight.ok) {
      console.warn(`[Payouts] Holding approved batch — ${preflight.reason}`);
      return [];
    }

    const results: PayoutResult[] = [];

    for (const payout of approvedPayouts) {
      if (
        opts.budgetMs !== undefined &&
        Date.now() - startedAt >= opts.budgetMs
      ) {
        console.warn(
          `[Payouts] Run budget spent; ${approvedPayouts.length - results.length} approved payout(s) left for the next run`,
        );
        break;
      }
      const result = await processSinglePayout(payout, opts.triggeredByUserId);
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
      select: { panEncrypted: true },
    }),
  ]);
  const readyPaise = Math.max(eligibility.readyAmount, 0);
  const tdsEstimatePaise =
    readyPaise > 0
      ? computeResidentPayoutTds(readyPaise, taxInfo?.panEncrypted)
          .tdsAmountPaise
      : 0;
  const recoveryPaise = Math.min(
    await outstandingClawbackPaise(prisma, {
      rail: "CONSULTANT",
      consultantProfileId,
    }),
    recoverablePaise(readyPaise, PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT, false),
  );
  return {
    readyPaise,
    tdsEstimatePaise,
    recoveryPaise,
    netPaise: readyPaise - tdsEstimatePaise - recoveryPaise,
    label: "Free · once a day",
    nextAllowedAt: usedToday ? nextIstMidnight(now) : null,
    reason: eligibility.reason,
  };
}

function subtractProportionalGrossRefund(
  grossPaise: number,
  sharePaise: number,
  refundedSharePaise: number,
): number {
  if (grossPaise <= 0 || refundedSharePaise <= 0) {
    return Math.max(0, grossPaise);
  }
  if (sharePaise > 0) {
    const proportionalGrossRefund = Math.round(
      (grossPaise * refundedSharePaise) / sharePaise,
    );
    return Math.max(0, grossPaise - proportionalGrossRefund);
  }
  return Math.max(0, grossPaise - refundedSharePaise);
}

function resolveTdsRateAppliedBps(tds: {
  rateAppliedBps?: number;
  tdsRate?: number | null;
}): number | null {
  if (tds.rateAppliedBps !== undefined) {
    return tds.rateAppliedBps;
  }
  if (tds.tdsRate !== null && tds.tdsRate !== undefined) {
    return tdsRateToBps(tds.tdsRate);
  }
  return null;
}

async function isMakerCheckerDisbursementBlocked(
  payoutId: string,
  approvedByValue: unknown,
  triggeredByUserId?: string,
): Promise<boolean> {
  const approvedBy =
    typeof approvedByValue === "string" ? approvedByValue : null;
  if (
    !triggeredByUserId ||
    !approvedBy ||
    approvedBy !== triggeredByUserId ||
    approvedBy === "SYSTEM_AUTO_APPROVE"
  ) {
    return false;
  }
  const makerCheckerRequired =
    process.env.PAYOUT_MAKER_CHECKER_REQUIRED !== "false";
  const activeAdminCount =
    typeof (
      prisma as { user?: { count?: (args: unknown) => Promise<number> } }
    ).user?.count === "function"
      ? await prisma.user.count({ where: { role: "ADMIN" } })
      : 2;
  if (!makerCheckerRequired || activeAdminCount <= 1) {
    return false;
  }
  console.warn(
    `[Payouts] Payout ${payoutId} skipped — triggered by the same admin (${triggeredByUserId}) who approved it`,
  );
  await recordSystemEventSafe({
    category: "PAYOUT",
    severity: "WARN",
    message: `PAYOUT_MAKER_CHECKER_DISBURSEMENT_SKIPPED: Payout ${payoutId} approved by ${approvedBy} cannot be disbursed by the same admin`,
    context: { payoutId, approvedBy, triggeredByUserId },
  });
  return true;
}

type ClaimGateOutcome =
  | { kind: "dispute_blocked" }
  | { kind: "refund_blocked" }
  | { kind: "shortfall"; owedPaise: number; shortfallReason: string }
  | { kind: "already_claimed" }
  | { kind: "claimed" };

async function runConsultantPayoutClaimGate(
  db: PrismaLike,
  payoutId: string,
  amount: number,
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
      },
    });
    if (failed.count > 0) {
      await db.consultantEarnings.updateMany({
        where: { payoutId, status: EarningStatus.BATCHED },
        data: { payoutId: null, status: EarningStatus.READY },
      });
      await releaseClawbackRecovery(db, payoutId);
    }
    return { kind: "shortfall", owedPaise, shortfallReason };
  }

  const claimed = await db.consultantPayout.updateMany({
    where: { id: payoutId, status: PayoutStatus.APPROVED },
    data: { status: PayoutStatus.PROCESSING },
  });
  if (claimed.count === 0) {
    return { kind: "already_claimed" };
  }
  return { kind: "claimed" };
}

async function claimConsultantPayoutForDisbursement(
  payoutId: string,
  amount: number,
): Promise<PayoutResult | null> {
  const claimOutcome =
    typeof prisma.$transaction === "function"
      ? await withSerializableRetry(
          () =>
            prisma.$transaction(
              (tx) => runConsultantPayoutClaimGate(tx, payoutId, amount),
              {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              },
            ),
          1,
        )
      : await runConsultantPayoutClaimGate(prisma, payoutId, amount);

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

async function computeConsultantPayoutTaxableBase(
  payout: { id: string; consultantProfileId: string; amount: number },
  cumulativeBeforePayout: number,
  financialYear: string,
  consultantTaxInfo: {
    taxEntityType?: string | null;
    panEncrypted?: unknown;
  } | null,
): Promise<{ taxablePaise: number; thresholdReason: string | null }> {
  const engine = process.env.TDS_ENGINE ?? "194O";
  const pure194O = engine !== "LEGACY";
  const gross194OEnabled =
    ENABLE_TDS_194O_GROSS && process.env.ENABLE_TDS_194O_GROSS !== "false";
  const cumulativeAfterPayout = cumulativeBeforePayout + payout.amount;

  if (!pure194O) {
    if (cumulativeAfterPayout <= TDS_THRESHOLD_PAISE) {
      return { taxablePaise: 0, thresholdReason: null };
    }
    const taxablePaise =
      cumulativeBeforePayout >= TDS_THRESHOLD_PAISE
        ? payout.amount
        : cumulativeAfterPayout - TDS_THRESHOLD_PAISE;
    return { taxablePaise, thresholdReason: null };
  }

  // #1901 — Always compute Section 194-O gross sale receipts (with the ₹5L
  // FY exemption for individuals/HUFs with PAN). When ENABLE_TDS_194O_GROSS
  // is explicitly "false", emit a shadow-diff SystemEvent if the gross base
  // differs from `payout.amount`.
  const grossAgg = await prisma.consultantEarnings.aggregate({
    where: { payoutId: payout.id },
    _sum: {
      grossAmount: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
    },
  });
  const rawGrossThisPayout = sumPaise(grossAgg._sum.grossAmount);
  const grossThisPayoutPaise =
    rawGrossThisPayout > 0
      ? subtractProportionalGrossRefund(
          rawGrossThisPayout,
          sumPaise(grossAgg._sum.consultantSharePaise),
          sumPaise(grossAgg._sum.refundedShareAmount),
        )
      : payout.amount;

  // Include both PAID and active BATCHED earnings in the FY so concurrent batches cannot double-spend the ₹5L exemption.
  const fyRange = getFYDateRange(financialYear);
  const priorGrossAgg = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId: payout.consultantProfileId,
      payoutId: { not: payout.id },
      OR: [
        {
          status: EarningStatus.PAID,
          paidAt: { gte: fyRange.start, lt: fyRange.end },
        },
        {
          status: EarningStatus.BATCHED,
          payout: {
            createdAt: { gte: fyRange.start, lt: fyRange.end },
            status: {
              notIn: [
                PayoutStatus.FAILED,
                PayoutStatus.CANCELLED,
                PayoutStatus.REVERSED,
              ],
            },
          },
        },
      ],
    },
    _sum: {
      grossAmount: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
    },
  });
  const grossBeforePaise = subtractProportionalGrossRefund(
    sumPaise(priorGrossAgg._sum.grossAmount),
    sumPaise(priorGrossAgg._sum.consultantSharePaise),
    sumPaise(priorGrossAgg._sum.refundedShareAmount),
  );

  const resolved = resolve194OTaxablePaise({
    grossBeforePaise,
    grossThisPayoutPaise,
    entityType: consultantTaxInfo?.taxEntityType ?? null,
    panOnFile: !!consultantTaxInfo?.panEncrypted,
  });

  if (gross194OEnabled) {
    return {
      taxablePaise: resolved.taxablePaise,
      thresholdReason: resolved.reason,
    };
  }

  if (resolved.taxablePaise !== payout.amount) {
    await recordSystemEventSafe({
      category: "PAYOUT",
      severity: "INFO",
      message: `TDS_194O_GROSS_SHADOW_DIFF: payout ${payout.id} grossTaxablePaise=${resolved.taxablePaise} differs from netSharePaise=${payout.amount}`,
      context: {
        payoutId: payout.id,
        consultantProfileId: payout.consultantProfileId,
        grossTaxablePaise: resolved.taxablePaise,
        netSharePaise: payout.amount,
        reason: resolved.reason,
      },
    });
  }
  return { taxablePaise: payout.amount, thresholdReason: null };
}

async function handleProcessSinglePayoutError(
  payoutId: string,
  error: unknown,
  providerPayoutId: string | undefined,
  submittedToGateway: boolean,
): Promise<PayoutResult> {
  const errorMessage =
    error instanceof Error ? error.message : "Unknown error";

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
      },
    });
    if (failed.count === 0) return;

    await tx.consultantEarnings.updateMany({
      where: { payoutId, status: EarningStatus.BATCHED },
      data: { payoutId: null, status: EarningStatus.READY },
    });
    await releaseClawbackRecovery(tx, payoutId);
  });

  return {
    payoutId,
    success: false,
    error: errorMessage,
  };
}

async function processSinglePayout(
  payout: {
    id: string;
    consultantProfileId: string;
    provider: PaymentGateway;
    amount: number;
    currency: string;
    method: PayoutMethod;
    idempotencyKey: string | null;
    consultantProfile: {
      payoutAccounts: Array<{
        razorpayFundAccId: string | null;
        accountType: string;
        [key: string]: unknown;
      }>;
      user: {
        name: string | null;
        email: string | null;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  },
  triggeredByUserId?: string,
): Promise<PayoutResult> {
  let providerPayoutId: string | undefined;
  let submittedToGateway = false;
  const markSubmitted = () => {
    submittedToGateway = true;
  };
  const financialYear = getIndianFinancialYear();
  try {
    if (
      await isMakerCheckerDisbursementBlocked(
        payout.id,
        payout.approvedBy,
        triggeredByUserId,
      )
    ) {
      return { payoutId: payout.id, success: false, skipped: true };
    }

    const blockedResult = await claimConsultantPayoutForDisbursement(
      payout.id,
      payout.amount,
    );
    if (blockedResult) {
      return blockedResult;
    }

    const account = payout.consultantProfile.payoutAccounts[0];
    if (!account) {
      throw new Error("No payout account found");
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

    const cumulativeBeforePayout = await getCurrentFYCumulativePayments(
      payout.consultantProfileId,
      financialYear,
    );
    const cumulativeAfterPayout = cumulativeBeforePayout + payout.amount;
    const { taxablePaise, thresholdReason } =
      await computeConsultantPayoutTaxableBase(
        payout,
        cumulativeBeforePayout,
        financialYear,
        consultantTaxInfo,
      );

    const resolvedTdsRate = await resolveEffectiveTdsRate(
      prisma,
      "194O",
      new Date(),
    );
    const tds =
      taxablePaise > 0
        ? computeResidentPayoutTds(
            taxablePaise,
            consultantTaxInfo?.panEncrypted,
            resolvedTdsRate,
          )
        : {
            tdsSection: "194O",
            rateAppliedBps: 0,
            rateApplied: 0,
            tdsRate: 0,
            tdsAmountPaise: 0,
            dtaaRateApplied: null,
            fallbackApplied: false,
            reason:
              thresholdReason ??
              `below ₹50K FY threshold (cumulative=${cumulativeAfterPayout} paise) — no TDS`,
          };

    const recoveredPaise = await clawbackRecoveredPaise(prisma, payout.id);
    const payoutAmountAfterTDS =
      payout.amount - tds.tdsAmountPaise - recoveredPaise;
    if (payoutAmountAfterTDS <= 0) {
      throw new Error(
        `Payout ${payout.id} nets to ${payoutAmountAfterTDS} paise after TDS and clawback recovery`,
      );
    }
    const tdsRateAppliedBps = resolveTdsRateAppliedBps(tds);

    if (tds.tdsAmountPaise > 0) {
      console.log(
        JSON.stringify({
          event: "tds_deduction",
          payoutId: payout.id,
          consultantProfileId: payout.consultantProfileId,
          grossAmount: payout.amount,
          taxableAmount: taxablePaise,
          cumulativeBeforePayout,
          cumulativeAfterPayout,
          tdsAmount: tds.tdsAmountPaise,
          tdsRate: tds.tdsRate,
          tdsSection: tds.tdsSection,
          netAmount: payoutAmountAfterTDS,
          financialYear,
          reason: tds.reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Stage TDS fields before gateway submission so an immediate completion webhook posts the net cash leg.
    const staged = await prisma.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.PROCESSING },
      data: {
        tdsDeducted: tds.tdsAmountPaise,
        netAmount: payoutAmountAfterTDS,
        tdsRateAppliedBps,
        tdsFinancialYear: financialYear,
      },
    });
    if (staged.count === 0) {
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

async function completeConsultantPayoutInTx(
  tx: Tx,
  matched: {
    id: string;
    consultantProfileId: string;
    amount: number;
    tdsDeducted: number;
    tdsRateAppliedBps: number | null;
    earnings?: unknown;
  },
): Promise<void> {
  const { financialYear, quarter, start, end } = resolveCompletionTdsWindow();
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
    const tdsPaise = matched.tdsDeducted ?? 0;
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
    },
  });

  await releaseClawbackRecovery(tx, payoutId);
}

async function notifyConsultantPayoutWebhookOutcome(
  payoutStatus: PayoutStatus,
  matched: {
    id: string;
    consultantProfileId: string;
    amount: number;
    netAmount: number | null;
    currency: string;
  },
): Promise<void> {
  if (payoutStatus === PayoutStatus.COMPLETED) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: matched.consultantProfileId },
      select: { userId: true },
    });
    if (profile?.userId) {
      // The bank receives the staged net: after TDS and any clawback recovery.
      await notifyPayoutProcessed(profile.userId, {
        amount: matched.netAmount ?? matched.amount,
        currency: matched.currency,
        payoutId: matched.id,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "earnings")}`,
      }).catch((error) => {
        console.error("[payouts] Failed to send payout notification:", error);
        reportSentryError(error, { subsystem: "payments", level: "warning" });
      });
    }
    return;
  }

  if (
    payoutStatus === PayoutStatus.FAILED ||
    payoutStatus === PayoutStatus.CANCELLED
  ) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: matched.consultantProfileId },
      select: { userId: true },
    });
    if (profile?.userId) {
      await notifyPayoutFailed(profile.userId, {
        amount: Number(matched.amount),
        currency: matched.currency,
        payoutId: matched.id,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "earnings")}`,
      }).catch((error) => {
        console.error("[payouts] Failed to send payout-failed notice:", error);
        reportSentryError(error, { subsystem: "payments", level: "warning" });
      });
    }
  }
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

  const didTransition = await prisma.$transaction(async (tx) => {
    // Terminal events claim any non-terminal row; non-terminal events only update PROCESSING rows.
    // Exclude FAILED when the incoming event is FAILED or CANCELLED so duplicate
    // failure webhooks do not re-trigger notifications.
    const terminalIncoming =
      payoutStatus === PayoutStatus.COMPLETED ||
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED;
    const excludedStatuses: PayoutStatus[] =
      payoutStatus === PayoutStatus.COMPLETED
        ? [
            PayoutStatus.COMPLETED,
            PayoutStatus.CANCELLED,
            PayoutStatus.REVERSED,
          ]
        : [
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
        status: payoutStatus,
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
      return true;
    }

    if (
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED
    ) {
      await failOrCancelConsultantPayoutInTx(tx, matched.id);
    }
    return true;
  });

  if (didTransition) {
    await notifyConsultantPayoutWebhookOutcome(payoutStatus, matched);
  }
}

/**
 * Atomically transitions COMPLETED → REVERSED when a bank reversal arrives
 * after completion, posting the inverse journal and reopening PAID earnings to READY.
 */
export async function markConsultantPayoutReversed(
  providerPayoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    const payout = await tx.consultantPayout.findFirst({
      where: { providerPayoutId },
      select: {
        id: true,
        consultantProfileId: true,
        amount: true,
        tdsDeducted: true,
        currency: true,
      },
    });
    if (!payout) {
      console.warn(
        `[payouts] markConsultantPayoutReversed: payout not found for provider ID ${providerPayoutId}`,
      );
      reportSentryMessage(
        "markConsultantPayoutReversed: payout not found for provider ID",
        {
          subsystem: "payments",
          level: "warning",
          extra: { providerPayoutId },
        },
      );
      return { wasNoOp: true, notify: null };
    }

    const claim = await tx.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.COMPLETED },
      data: {
        status: PayoutStatus.REVERSED,
        failureReason: reason.slice(0, 500),
      },
    });
    if (claim.count === 0) {
      reportSentryMessage(
        "markConsultantPayoutReversed: no-op (not COMPLETED)",
        {
          subsystem: "payments",
          expected: true,
          extra: { payoutId: payout.id },
        },
      );
      return { wasNoOp: true, notify: null };
    }

    await tx.consultantEarnings.updateMany({
      where: { payoutId: payout.id, status: EarningStatus.PAID },
      data: { status: EarningStatus.READY, payoutId: null, paidAt: null },
    });

    const recoveredPaise = await clawbackRecoveredPaise(tx, payout.id);
    if (payout.amount - recoveredPaise > 0) {
      const tdsPaise = payout.tdsDeducted ?? 0;
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
      const { recordTdsReversal } = await import(
        "@/lib/payments/tax/tds-service"
      );
      await recordTdsReversal(tx, {
        payoutId: payout.id,
        consultantProfileId: payout.consultantProfileId,
        refundAmountPaise: payout.amount,
        paymentAmountPaise: payout.amount,
      });
    }

    await releaseClawbackRecovery(tx, payout.id);

    console.log(
      `↩️  Consultant payout ${payout.id} reversed after completion (provider=${providerPayoutId}): ${reason.slice(0, 200)}`,
    );

    return { wasNoOp: false, notify: null };
  });

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
