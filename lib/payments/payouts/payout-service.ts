/**
 * Payout Service
 * Provider-agnostic consultant payout orchestration with admin approval workflow.
 */

import * as Sentry from "@sentry/nextjs";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import prisma from "@/lib/prisma";
import {
  PayoutStatus,
  PayoutMethod,
  PaymentGateway,
  EarningStatus,
  RefundStatus,
  type Prisma,
} from "@prisma/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { Refusal } from "@/lib/errors/refusal";
import {
  INSTANT_PAYOUT_AUTO_APPROVE_PAISE,
  PAYOUT_CONSTANTS,
} from "./constants";
import {
  payoutEligibilityReason,
  type PayoutEligibilityReason,
} from "./payout-requirements";
import { isPostMvpGatewayStub } from "@/lib/payments/constants";
import {
  getRazorpayPayoutsService,
  isDefinitiveGatewayRejection,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
import {
  getStripeConnectService,
  isStripeConnectConfigured,
} from "./stripe-connect";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
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
  resolveCompletionTdsWindow,
  resolvePayoutMsmeDeadline,
  tdsRateToBps,
} from "./shared-lifecycle";

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

/**
 * Refund statuses that must NOT block a payout: FAILED and CANCELLED never
 * returned the money. Refund-side sibling of `DISPUTE_INACTIVE_FOR_GATING`.
 */
const REFUND_INACTIVE_FOR_GATING: RefundStatus[] = [
  RefundStatus.FAILED,
  RefundStatus.CANCELLED,
];

export async function createPayoutBatch(
  consultantProfileIds?: string[],
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
  autoApprove: (amountPaise: number) => boolean;
}

/**
 * Atomically sums a consultant's READY earnings, creates the payout row, and
 * claims the earnings READY → BATCHED inside a single transaction.
 */
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

  // Skip unsupported post-MVP gateway stubs before claiming earnings into BATCHED.
  if (isPostMvpGatewayStub(account.provider)) {
    console.warn(
      `Skipping consultant ${consultantProfileId}: payout account is on ` +
        `"${account.provider}", which has no implementation (post-MVP stub).`,
    );
    return null;
  }

  let method: PayoutMethod;
  switch (account.accountType) {
    case "UPI":
      method = PayoutMethod.UPI;
      break;
    case "STRIPE_CONNECT":
      method = PayoutMethod.STRIPE_TRANSFER;
      break;
    default:
      method = PayoutMethod.BANK_TRANSFER;
  }

  const msmeProfile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { msmeStatus: true, writtenAgreementWithFamiliarise: true },
  });

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
        approvedAt: shouldAutoApprove ? new Date() : undefined,
        approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
        mustPayByDate: resolvePayoutMsmeDeadline(
          msmeProfile?.msmeStatus,
          msmeProfile?.writtenAgreementWithFamiliarise,
        ),
      },
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
  opts: { budgetMs?: number; lockTtlMs?: number } = {},
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
  return {
    readyPaise,
    tdsEstimatePaise,
    netPaise: readyPaise - tdsEstimatePaise,
    label: "Free · once a day",
    nextAllowedAt: usedToday ? nextIstMidnight(now) : null,
    reason: eligibility.reason,
  };
}

async function processSinglePayout(payout: {
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
      stripeAccountId: string | null;
      accountType: string;
      [key: string]: unknown;
    }>;
    user: { name: string | null; email: string | null; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}): Promise<PayoutResult> {
  let providerPayoutId: string | undefined;
  let submittedToGateway = false;
  const markSubmitted = () => {
    submittedToGateway = true;
  };
  const financialYear = getIndianFinancialYear();
  try {
    // Block disbursement if any underlying payment has an active dispute.
    const disputedEarning = await prisma.consultantEarnings.findFirst({
      where: {
        payoutId: payout.id,
        payment: DISPUTE_GATED_PAYMENT_WHERE,
      },
      select: { id: true },
    });
    if (disputedEarning) {
      console.warn(
        `[Payouts] Payout ${payout.id} blocked — an earning's payment has a live dispute`,
      );
      reportSentryMessage("Payout blocked by live dispute", {
        subsystem: "payments",
        expected: true,
        extra: { payoutId: payout.id },
      });
      return { payoutId: payout.id, success: false, skipped: true };
    }

    // A refund that is PENDING or not yet cascaded onto the earning would be
    // paid to the consultant AND returned to the buyer. Block until it lands.
    const refundPendingEarning = await prisma.consultantEarnings.findFirst({
      where: {
        payoutId: payout.id,
        payment: {
          refunds: {
            some: {
              status: { notIn: REFUND_INACTIVE_FOR_GATING },
              OR: [{ status: RefundStatus.PENDING }, { cascadedAt: null }],
            },
          },
        },
      },
      select: { id: true },
    });
    if (refundPendingEarning) {
      console.warn(
        `[Payouts] Payout ${payout.id} blocked — an earning's payment has an uncascaded refund`,
      );
      reportSentryMessage("Payout blocked by an uncascaded refund", {
        subsystem: "payments",
        expected: true,
        extra: { payoutId: payout.id },
      });
      return { payoutId: payout.id, success: false, skipped: true };
    }

    // `payout.amount` is frozen at batch time; a reversal landing on a BATCHED
    // earning afterwards lowers what is owed. Never disburse more than that.
    const owedAgg = await prisma.consultantEarnings.aggregate({
      where: { payoutId: payout.id },
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
    });
    const owedPaise =
      sumPaise(owedAgg._sum.consultantSharePaise) -
      sumPaise(owedAgg._sum.refundedShareAmount);
    if (owedPaise < payout.amount) {
      const shortfallReason = `SHORTFALL_BEFORE_DISBURSEMENT: earnings owe ${owedPaise}p < batched ${payout.amount}p`;
      console.warn(`[Payouts] Payout ${payout.id} failed — ${shortfallReason}`);
      const failShortfall = async (
        db: Pick<typeof prisma, "consultantPayout" | "consultantEarnings">,
      ) => {
        const failed = await db.consultantPayout.updateMany({
          where: { id: payout.id, status: PayoutStatus.APPROVED },
          data: {
            status: PayoutStatus.FAILED,
            failureReason: shortfallReason.slice(0, 500),
            tdsDeducted: 0,
            netAmount: null,
            tdsRateAppliedBps: null,
            tdsFinancialYear: null,
          },
        });
        if (failed.count === 0) return;

        await db.consultantEarnings.updateMany({
          where: { payoutId: payout.id, status: EarningStatus.BATCHED },
          data: { payoutId: null, status: EarningStatus.READY },
        });
      };
      if (typeof prisma.$transaction === "function") {
        await prisma.$transaction((tx) => failShortfall(tx));
      } else {
        await failShortfall(prisma);
      }
      reportSentryMessage("payout-batch-earnings-shortfall", {
        subsystem: "payments",
        level: "error",
        extra: { payoutId: payout.id, owedPaise, amount: payout.amount },
      });
      return {
        payoutId: payout.id,
        success: false,
        error: shortfallReason,
      };
    }

    // Atomic CAS claim APPROVED → PROCESSING so concurrent runners cannot double-submit.
    const claimed = await prisma.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.APPROVED },
      data: { status: PayoutStatus.PROCESSING },
    });
    if (claimed.count === 0) {
      console.warn(
        `[Payouts] Payout ${payout.id} already claimed by a concurrent run — skipping`,
      );
      reportSentryMessage("Payout CAS claim lost to a concurrent runner", {
        subsystem: "payments",
        expected: true,
        extra: { payoutId: payout.id },
      });
      return { payoutId: payout.id, success: false, skipped: true };
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

    const engine = process.env.TDS_ENGINE ?? "194O";
    const pure194O = engine !== "LEGACY";
    const cumulativeBeforePayout = await getCurrentFYCumulativePayments(
      payout.consultantProfileId,
      financialYear,
    );
    const cumulativeAfterPayout = cumulativeBeforePayout + payout.amount;
    let taxablePaise = 0;
    let thresholdReason: string | null = null;

    if (pure194O && ENABLE_TDS_194O_GROSS) {
      // Section 194-O applies to gross sale receipts with the ₹5L FY exemption for individuals/HUFs with PAN.
      const grossAgg = await prisma.consultantEarnings.aggregate({
        where: { payoutId: payout.id },
        _sum: { grossAmount: true, refundedShareAmount: true },
      });
      const grossThisPayoutPaise =
        sumPaise(grossAgg._sum.grossAmount) -
        sumPaise(grossAgg._sum.refundedShareAmount);

      // Include both PAID and active BATCHED earnings in the FY so concurrent batches cannot double-spend the ₹5L exemption.
      const { start, end } = getFYDateRange(financialYear);
      const priorGrossAgg = await prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId: payout.consultantProfileId,
          payoutId: { not: payout.id },
          OR: [
            { status: EarningStatus.PAID, paidAt: { gte: start, lt: end } },
            {
              status: EarningStatus.BATCHED,
              payout: {
                createdAt: { gte: start, lt: end },
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
        _sum: { grossAmount: true, refundedShareAmount: true },
      });
      const grossBeforePaise =
        sumPaise(priorGrossAgg._sum.grossAmount) -
        sumPaise(priorGrossAgg._sum.refundedShareAmount);

      const resolved = resolve194OTaxablePaise({
        grossBeforePaise,
        grossThisPayoutPaise,
        entityType: consultantTaxInfo?.taxEntityType ?? null,
        panOnFile: !!consultantTaxInfo?.panEncrypted,
      });
      taxablePaise = resolved.taxablePaise;
      thresholdReason = resolved.reason;
    } else if (pure194O) {
      taxablePaise = payout.amount;
    } else if (cumulativeAfterPayout > TDS_THRESHOLD_PAISE) {
      taxablePaise =
        cumulativeBeforePayout >= TDS_THRESHOLD_PAISE
          ? payout.amount
          : cumulativeAfterPayout - TDS_THRESHOLD_PAISE;
    }

    const tds =
      taxablePaise > 0
        ? computeResidentPayoutTds(taxablePaise, consultantTaxInfo?.panEncrypted)
        : {
            tdsSection: "194O",
            tdsRate: 0,
            tdsAmountPaise: 0,
            dtaaRateApplied: null,
            fallbackApplied: false,
            reason:
              thresholdReason ??
              `below ₹50K FY threshold (cumulative=${cumulativeAfterPayout} paise) — no TDS`,
          };

    const payoutAmountAfterTDS = payout.amount - tds.tdsAmountPaise;
    const tdsRateAppliedBps =
      tds.tdsRate !== null && tds.tdsRate !== undefined
        ? tdsRateToBps(tds.tdsRate)
        : null;

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
    } else if (payout.provider === PaymentGateway.STRIPE) {
      providerPayoutId = await processStripePayout(
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // If the gateway already accepted the transfer, quarantine in PROCESSING with earnings linked to prevent double-disbursement.
    if (providerPayoutId) {
      try {
        await prisma.consultantPayout.updateMany({
          where: { id: payout.id, providerPayoutId: null },
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
          `[payout-service] CRITICAL: gateway accepted ${providerPayoutId} but DB persist failed twice for payout ${payout.id}; manual reconcile required`,
          persistErr,
        );
        reportSentryError(persistErr, {
          subsystem: "payments",
          level: "fatal",
          contexts: { payout: { payoutId: payout.id, providerPayoutId } },
        });
      }
      console.error(
        `⚠️ Payout ${payout.id}: gateway accepted ${providerPayoutId} but DB write failed — quarantined PROCESSING (NOT failed) to avoid double-pay`,
      );
      reportSentryError(
        new Error(`gateway-accepted-db-write-failed: payout ${payout.id}`),
        {
          subsystem: "payments",
          contexts: { payout: { payoutId: payout.id, providerPayoutId } },
        },
      );
      return {
        payoutId: payout.id,
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
            id: payout.id,
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
        contexts: { payout: { payoutId: payout.id } },
      });
      return {
        payoutId: payout.id,
        success: false,
        error: `gateway-outcome-unknown: ${errorMessage}`,
      };
    }

    // Never submitted or definitively rejected: CAS transition PROCESSING → FAILED and release BATCHED earnings back to READY.
    await prisma.$transaction(async (tx) => {
      const failed = await tx.consultantPayout.updateMany({
        where: { id: payout.id, status: PayoutStatus.PROCESSING },
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
        where: { payoutId: payout.id, status: EarningStatus.BATCHED },
        data: { payoutId: null, status: EarningStatus.READY },
      });
    });

    return {
      payoutId: payout.id,
      success: false,
      error: errorMessage,
    };
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

async function processStripePayout(
  payout: {
    id: string;
    amount: number;
    currency: string;
    idempotencyKey: string | null;
  },
  account: {
    stripeAccountId: string | null;
  },
  onSubmit: () => void,
): Promise<string> {
  if (!isStripeConnectConfigured()) {
    throw new Error("Stripe Connect not configured");
  }

  if (!account.stripeAccountId) {
    throw new Error("Stripe connected account not found");
  }

  const stripeConnect = getStripeConnectService();

  onSubmit();
  const transfer = await stripeConnect.createTransfer({
    amount: payout.amount,
    currency: payout.currency.toLowerCase(),
    destinationAccountId: account.stripeAccountId,
    description: `Payout ${payout.id}`,
    idempotencyKey: payout.idempotencyKey || `payout_${payout.id}`,
    metadata: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return transfer.id;
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

  let payoutStatus: PayoutStatus;
  switch (status) {
    case "COMPLETED":
      payoutStatus = PayoutStatus.COMPLETED;
      break;
    case "FAILED":
      payoutStatus = PayoutStatus.FAILED;
      break;
    case "CANCELLED":
      payoutStatus = PayoutStatus.CANCELLED;
      break;
    case "PROCESSING":
      payoutStatus = PayoutStatus.PROCESSING;
      break;
    case "PENDING":
      payoutStatus = PayoutStatus.PENDING;
      break;
    default:
      await reportUnknownPayoutStatus({
        provider: _provider,
        providerPayoutId,
        status: String(status),
      });
      return;
  }

  const stampWhere = stampProviderId ? { providerPayoutId: null } : {};
  const stampData = stampProviderId ? { providerPayoutId } : {};

  await prisma.$transaction(async (tx) => {
    // Terminal events claim any non-terminal row; non-terminal events only update PROCESSING rows.
    const terminalIncoming =
      payoutStatus === PayoutStatus.COMPLETED ||
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED;
    const { count } = await tx.consultantPayout.updateMany({
      where: {
        id: matched.id,
        ...stampWhere,
        status: terminalIncoming
          ? {
              notIn: [
                PayoutStatus.COMPLETED,
                PayoutStatus.CANCELLED,
                PayoutStatus.REVERSED,
              ],
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
      return;
    }

    if (payoutStatus === PayoutStatus.COMPLETED) {
      const { financialYear, quarter, start, end } =
        resolveCompletionTdsWindow();
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

      if (matched.amount > 0) {
        const tdsPaise = matched.tdsDeducted ?? 0;
        const cashPaise = matched.amount - tdsPaise;
        await postLedgerTxn(tx, {
          idempotencyKey: `payout:${matched.id}`,
          kind: "PAYOUT",
          payoutId: matched.id,
          postings: buildPayoutCompletionPostings({
            payableAccount: {
              kind: "CONSULTANT_PAYABLE",
              consultantProfileId: matched.consultantProfileId,
            },
            grossPayablePaise: matched.amount,
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

    if (
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED
    ) {
      await tx.consultantEarnings.updateMany({
        where: { payoutId: matched.id, status: EarningStatus.BATCHED },
        data: {
          payoutId: null,
          status: EarningStatus.READY,
        },
      });

      await tx.tDSRecord.deleteMany({
        where: { payoutId: matched.id },
      });

      await tx.consultantPayout.update({
        where: { id: matched.id },
        data: {
          tdsDeducted: 0,
          netAmount: null,
          tdsRateAppliedBps: null,
          tdsFinancialYear: null,
        },
      });
    }
  });

  if (payoutStatus === PayoutStatus.COMPLETED) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: matched.consultantProfileId },
      select: { userId: true },
    });
    if (profile?.userId) {
      await notifyPayoutProcessed(profile.userId, {
        amount: Number(matched.amount),
        currency: matched.currency,
        payoutId: matched.id,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "earnings")}`,
      }).catch((error) => {
        console.error("[payouts] Failed to send payout notification:", error);
        reportSentryError(error, { subsystem: "payments", level: "warning" });
      });
    }
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

    if (payout.amount > 0) {
      const tdsPaise = payout.tdsDeducted ?? 0;
      const cashPaise = payout.amount - tdsPaise;
      await postLedgerTxn(tx, {
        idempotencyKey: `payout-reversal:${payout.id}`,
        kind: "PAYOUT",
        payoutId: payout.id,
        postings: buildPayoutReversalPostings({
          payableAccount: {
            kind: "CONSULTANT_PAYABLE",
            consultantProfileId: payout.consultantProfileId,
          },
          grossPayablePaise: payout.amount,
          netCashPaise: cashPaise,
          tdsPaise,
        }),
      });
    }

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
