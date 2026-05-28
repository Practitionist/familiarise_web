/**
 * Payout Service
 * Provider-agnostic payout orchestration with admin approval workflow
 */

import prisma from "@/lib/prisma";
import {
  PayoutStatus,
  PayoutMethod,
  PaymentGateway,
  EarningStatus,
} from "@prisma/client";
import { PAYOUT_CONSTANTS } from "./constants";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
import {
  getStripeConnectService,
  isStripeConnectConfigured,
} from "./stripe-connect";
import { randomUUID } from "crypto";
import { acquireLock, releaseLock } from "@/lib/redis";
import {
  calculateTDS,
  getFYDateRange,
  getIndianFinancialYear,
  recordTDSDeduction,
} from "@/lib/payments/tax/tds-service";
import { notifyPayoutProcessed } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";

// ============================================
// Types
// ============================================

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
  hasPayoutAccount: boolean;
  defaultAccountId?: string;
  provider?: PaymentGateway;
}

// ============================================
// Payout Service
// ============================================

/**
 * Get all pending payouts awaiting admin approval
 */
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

/**
 * Get payout details by ID
 */
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

/**
 * Check consultant's payout eligibility
 */
export async function checkPayoutEligibility(
  consultantProfileId: string,
): Promise<ConsultantPayoutEligibility> {
  // FIX #617: Subtract refundedShareAmount from payout eligibility.
  // Use aggregate _sum of both fields (efficient DB-side) then subtract in JS.
  // refundedShareAmount is capped at consultantSharePaise by refundEarnings(), so the
  // difference is always >= 0.
  const readyEarningsAgg = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });

  const readyAmount =
    (readyEarningsAgg._sum.consultantSharePaise || 0) -
    (readyEarningsAgg._sum.refundedShareAmount || 0);

  // Get default payout account
  const defaultAccount = await prisma.payoutAccount.findFirst({
    where: {
      consultantProfileId,
      isDefault: true,
      isVerified: true,
    },
  });

  return {
    consultantProfileId,
    isEligible:
      readyAmount >= PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT && !!defaultAccount,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    hasPayoutAccount: !!defaultAccount,
    defaultAccountId: defaultAccount?.id,
    provider: defaultAccount?.provider,
  };
}

/**
 * Create a payout batch for approval
 * Called weekly (every Monday)
 *
 * NEW-2: Uses a distributed lock to prevent concurrent batch creation.
 * Without this, two concurrent calls (e.g., admin click + cron job) could both
 * read the same READY earnings, create separate payouts for the same consultant,
 * and leave orphaned payout records with no linked earnings.
 */
const PAYOUT_BATCH_LOCK_KEY = "lock:payout_batch_creation";
const PAYOUT_BATCH_LOCK_TTL = 120_000; // 2 minutes — generous for large batches

export async function createPayoutBatch(
  consultantProfileIds?: string[],
): Promise<string> {
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

    // Get eligible consultants with ready earnings >= minimum payout
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

    // FIX #568: Create each payout inside a transaction so the amount
    // recorded always matches the earnings actually linked. The groupBy
    // above gives us candidates; the transaction re-queries the exact
    // earnings, sums them, creates the payout, and links — atomically.
    for (const consultant of eligibleConsultants) {
      const { consultantProfileId } = consultant;

      // Get consultant's default payout account
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
        continue;
      }

      // Determine payout method based on account type
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

      await prisma.$transaction(async (tx) => {
        // Re-query exact READY earnings inside the transaction
        const readyEarnings = await tx.consultantEarnings.findMany({
          where: {
            consultantProfileId,
            status: EarningStatus.READY,
            payoutId: null,
          },
          select: { id: true, consultantSharePaise: true, refundedShareAmount: true },
        });

        if (readyEarnings.length === 0) return;

        // FIX #617: Subtract refundedShareAmount so partially refunded earnings
        // are paid at the correct (reduced) amount, not the original full share.
        const amount = readyEarnings.reduce(
          (sum, e) =>
            sum + Math.max(e.consultantSharePaise - e.refundedShareAmount, 0),
          0,
        );

        if (amount < PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT) return;

        const shouldAutoApprove =
          amount < PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD;

        // Create payout with the exact amount
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
            idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
            approvedAt: shouldAutoApprove ? new Date() : undefined,
            approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
          },
        });

        // Link the exact earnings we summed, with guards against concurrent state changes
        const linkResult = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: readyEarnings.map((e) => e.id) },
            status: EarningStatus.READY,
            payoutId: null,
          },
          data: {
            payoutId: payout.id,
          },
        });

        // If not all targeted earnings were linked, some changed state concurrently
        if (linkResult.count !== readyEarnings.length) {
          throw new Error(
            `Payout linking race: expected ${readyEarnings.length} earnings, linked ${linkResult.count} for consultant ${consultantProfileId}. Rolling back.`,
          );
        }
      });
    }

    return batchId;
  } finally {
    await releaseLock(PAYOUT_BATCH_LOCK_KEY, lockToken);
  }
}

/**
 * Approve a payout (admin action)
 *
 * C3 FIX: Validates payout is in PENDING status before approving.
 * Without this, a COMPLETED/PROCESSING/FAILED payout could be re-approved,
 * potentially causing double payouts.
 */
export async function approvePayout(
  payoutId: string,
  adminUserId: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findUnique({
    where: { id: payoutId },
  });

  if (!payout) {
    throw new Error(`Payout ${payoutId} not found`);
  }

  if (payout.status !== PayoutStatus.PENDING) {
    throw new Error(
      `Payout ${payoutId} cannot be approved (current status: ${payout.status}). Only PENDING payouts can be approved.`,
    );
  }

  await prisma.consultantPayout.update({
    where: { id: payoutId },
    data: {
      status: PayoutStatus.APPROVED,
      approvedAt: new Date(),
      approvedBy: adminUserId,
    },
  });
}

/**
 * Reject a payout (admin action)
 *
 * M4 FIX: Validates payout is in PENDING status before rejecting.
 * Without this, a PROCESSING or COMPLETED payout could be rejected,
 * unlinking earnings that may already be paid out.
 */
export async function rejectPayout(
  payoutId: string,
  reason: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findUnique({
    where: { id: payoutId },
    include: { earnings: true },
  });

  if (!payout) {
    throw new Error("Payout not found");
  }

  if (payout.status !== PayoutStatus.PENDING) {
    throw new Error(
      `Payout ${payoutId} cannot be rejected (current status: ${payout.status}). Only PENDING payouts can be rejected.`,
    );
  }

  // Unlink earnings and set them back to READY
  await prisma.consultantEarnings.updateMany({
    where: { payoutId },
    data: {
      payoutId: null,
    },
  });

  // Cancel the payout
  await prisma.consultantPayout.update({
    where: { id: payoutId },
    data: {
      status: PayoutStatus.CANCELLED,
      failureReason: reason,
    },
  });
}

/**
 * Process all approved payouts
 *
 * C4 FIX: Uses a distributed lock to prevent concurrent processing.
 * Without this, two workers (or cron triggers) could fetch the same APPROVED
 * payouts and send duplicate payments to the gateway.
 * Additionally, each payout is atomically claimed (APPROVED → PROCESSING)
 * before gateway calls to prevent double-processing.
 */
const PAYOUT_PROCESS_LOCK_KEY = "lock:payout_processing";
const PAYOUT_PROCESS_LOCK_TTL = 300_000; // 5 minutes — generous for batch processing

export async function processApprovedPayouts(): Promise<PayoutResult[]> {
  const lockToken = await acquireLock(
    PAYOUT_PROCESS_LOCK_KEY,
    PAYOUT_PROCESS_LOCK_TTL,
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
      include: {
        consultantProfile: {
          include: {
            payoutAccounts: {
              where: { isDefault: true, isVerified: true },
            },
            user: true,
          },
        },
      },
    });

    const results: PayoutResult[] = [];

    for (const payout of approvedPayouts) {
      const result = await processSinglePayout(payout);
      results.push(result);
    }

    return results;
  } finally {
    await releaseLock(PAYOUT_PROCESS_LOCK_KEY, lockToken);
  }
}

/**
 * Process a single payout
 */
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
  try {
    // Mark as processing
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: { status: PayoutStatus.PROCESSING },
    });

    const account = payout.consultantProfile.payoutAccounts[0];
    if (!account) {
      throw new Error("No payout account found");
    }

    // Non-resident payout guard — Razorpay only pays to Indian bank accounts
    const consultantTaxInfo = await prisma.consultantTaxInfo.findUnique({
      where: { consultantProfileId: payout.consultantProfileId },
    });
    if (consultantTaxInfo && !consultantTaxInfo.isIndianResident) {
      throw new Error(
        "Payouts to non-resident consultants are not supported yet (Section 195 TDS not implemented). " +
          `Consultant: ${payout.consultantProfileId}. Please process this payout manually.`,
      );
    }

    // Calculate TDS (Section 194J) — deduct before sending to gateway
    const tdsResult = await calculateTDS({
      consultantProfileId: payout.consultantProfileId,
      payoutAmountPaise: payout.amount,
    });

    const payoutAmountAfterTDS = payout.amount - tdsResult.tdsAmount;

    if (tdsResult.tdsAmount > 0) {
      console.log(
        JSON.stringify({
          event: "tds_deduction",
          payoutId: payout.id,
          consultantProfileId: payout.consultantProfileId,
          grossAmount: payout.amount,
          tdsAmount: tdsResult.tdsAmount,
          tdsRate: tdsResult.tdsRate,
          netAmount: payoutAmountAfterTDS,
          financialYear: tdsResult.financialYear,
          cumulativeBeforePayout: tdsResult.cumulativeBeforePayout,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Use the payout object but with reduced amount for gateway call
    const payoutForGateway = { ...payout, amount: payoutAmountAfterTDS };

    let providerPayoutId: string | undefined;

    if (payout.provider === PaymentGateway.RAZORPAY) {
      providerPayoutId = await processRazorpayPayout(payoutForGateway, account);
    } else if (payout.provider === PaymentGateway.STRIPE) {
      providerPayoutId = await processStripePayout(payoutForGateway, account);
    } else {
      throw new Error(`Unsupported provider: ${payout.provider}`);
    }

    // Update payout with provider ID and TDS info
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        providerPayoutId,
        tdsDeducted: tdsResult.tdsAmount,
        netAmount: payoutAmountAfterTDS,
        tdsRateApplied: tdsResult.tdsRate || null,
        tdsFinancialYear: tdsResult.financialYear,
        status: PayoutStatus.PROCESSING, // Will be updated via webhook
      },
    });

    return {
      payoutId: payout.id,
      success: true,
      providerPayoutId,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Mark as failed
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: errorMessage,
        retryCount: { increment: 1 },
        tdsDeducted: 0,
        netAmount: null,
        tdsRateApplied: null,
        tdsFinancialYear: null,
      },
    });

    // C5 FIX: Unlink earnings from the failed payout so they can be
    // picked up by the next batch. Without this, earnings linked to a
    // payout that failed before the gateway call (e.g., "No payout account")
    // would remain orphaned since no webhook fires to unlink them.
    await prisma.consultantEarnings.updateMany({
      where: { payoutId: payout.id },
      data: { payoutId: null },
    });

    return {
      payoutId: payout.id,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Process payout via RazorpayX
 */
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
): Promise<string> {
  if (!isRazorpayPayoutsConfigured()) {
    throw new Error("RazorpayX Payouts not configured");
  }

  // Guard: Razorpay only processes INR payouts
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

  // Determine payout mode
  const mode = razorpayPayouts.determinePayoutMode(
    payout.amount,
    account.accountType === "UPI" ? "vpa" : "bank_account",
  );

  const result = await razorpayPayouts.createPayout({
    fundAccountId: account.razorpayFundAccId,
    amount: payout.amount,
    currency: payout.currency,
    mode,
    purpose: "payout",
    queueIfLowBalance: true,
    referenceId: payout.id,
    idempotencyKey:
      payout.idempotencyKey || `payout_${payout.id}_${Date.now()}`,
    notes: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return result.id;
}

/**
 * Process payout via Stripe Connect
 */
async function processStripePayout(
  payout: {
    id: string;
    amount: number;
    currency: string;
  },
  account: {
    stripeAccountId: string | null;
  },
): Promise<string> {
  if (!isStripeConnectConfigured()) {
    throw new Error("Stripe Connect not configured");
  }

  if (!account.stripeAccountId) {
    throw new Error("Stripe connected account not found");
  }

  const stripeConnect = getStripeConnectService();

  // Create a transfer from platform to connected account
  const transfer = await stripeConnect.createTransfer({
    amount: payout.amount,
    currency: payout.currency.toLowerCase(),
    destinationAccountId: account.stripeAccountId,
    description: `Payout ${payout.id}`,
    metadata: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return transfer.id;
}

/**
 * Handle payout webhook from provider
 *
 * C6 FIX: Wrapped in a prisma.$transaction() to ensure atomicity.
 * Without this, the payout status, earnings status, and consultant stats
 * could get out of sync if any individual DB call fails mid-way.
 */
export async function handlePayoutWebhook(
  _provider: PaymentGateway,
  providerPayoutId: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED",
  failureReason?: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findFirst({
    where: { providerPayoutId },
    include: { earnings: true },
  });

  if (!payout) {
    console.warn(`Payout not found for provider ID: ${providerPayoutId}`);
    return;
  }

  // Map external status to our enum
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
    default:
      payoutStatus = PayoutStatus.PENDING;
  }

  await prisma.$transaction(async (tx) => {
    // Atomic conditional update: only transition if payout is NOT already terminal.
    // Uses updateMany with status filter so concurrent duplicates cannot both succeed.
    const { count } = await tx.consultantPayout.updateMany({
      where: {
        id: payout.id,
        status: { notIn: [PayoutStatus.COMPLETED, PayoutStatus.CANCELLED] },
      },
      data: {
        status: payoutStatus,
        processedAt:
          payoutStatus === PayoutStatus.COMPLETED ? new Date() : undefined,
        failureReason: failureReason,
      },
    });

    if (count === 0) {
      console.log(
        `Payout ${payout.id} already in terminal state, skipping duplicate ${status} webhook`,
      );
      return;
    }

    // If completed, update earnings and consultant stats
    if (payoutStatus === PayoutStatus.COMPLETED) {
      const financialYear = payout.tdsFinancialYear || getIndianFinancialYear();
      const { start, end } = getFYDateRange(financialYear);
      const previousCompletedPayouts = await tx.consultantPayout.aggregate({
        where: {
          consultantProfileId: payout.consultantProfileId,
          status: PayoutStatus.COMPLETED,
          processedAt: { gte: start, lte: end },
          id: { not: payout.id },
        },
        _sum: { amount: true },
      });
      const cumulativeCreditedPayments =
        (previousCompletedPayouts._sum.amount || 0) + payout.amount;

      // Update earnings to PAID
      await tx.consultantEarnings.updateMany({
        where: { payoutId: payout.id },
        data: {
          status: EarningStatus.PAID,
          paidAt: new Date(),
        },
      });

      // Update consultant stats
      await tx.consultantProfile.update({
        where: { id: payout.consultantProfileId },
        data: {
          totalRevenue: { increment: payout.amount },
          pendingRevenue: { decrement: payout.amount },
        },
      });

      if (payout.tdsDeducted > 0 && payout.tdsRateApplied) {
        await tx.tDSRecord.deleteMany({
          where: { payoutId: payout.id },
        });

        await recordTDSDeduction({
          consultantProfileId: payout.consultantProfileId,
          financialYear,
          tdsDeducted: payout.tdsDeducted,
          tdsRate: payout.tdsRateApplied,
          cumulativeAmountCredited: cumulativeCreditedPayments,
          payoutId: payout.id,
          db: tx,
        });
      }
    }

    // If failed or cancelled, unlink earnings and reverse TDS records
    if (
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED
    ) {
      await tx.consultantEarnings.updateMany({
        where: { payoutId: payout.id },
        data: {
          payoutId: null,
        },
      });

      // Delete TDS records — payout never completed, so TDS was never actually withheld
      await tx.tDSRecord.deleteMany({
        where: { payoutId: payout.id },
      });

      // Reset TDS fields on the payout record
      await tx.consultantPayout.update({
        where: { id: payout.id },
        data: {
          tdsDeducted: 0,
          netAmount: null,
          tdsRateApplied: null,
          tdsFinancialYear: null,
        },
      });
    }
  });

  // Fire-and-forget: notify consultant when payout completes
  if (payoutStatus === PayoutStatus.COMPLETED) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: payout.consultantProfileId },
      select: { userId: true },
    });
    if (profile?.userId) {
      void notifyPayoutProcessed(profile.userId, {
        amount: Number(payout.amount),
        currency: payout.currency,
        payoutId: payout.id,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch((error) =>
        console.error("[payouts] Failed to send payout notification:", error),
      );
    }
  }
}

/**
 * Get payout statistics for dashboard
 */
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
      amount: pending._sum.amount || 0,
    },
    processing: {
      count: processing._count,
      amount: processing._sum.amount || 0,
    },
    completed: {
      count: completed._count,
      amount: completed._sum.amount || 0,
    },
    failed: {
      count: failed._count,
      amount: failed._sum.amount || 0,
    },
  };
}
