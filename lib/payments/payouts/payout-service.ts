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
  const payouts = await prisma.payout.findMany({
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
  return prisma.payout.findUnique({
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
  consultantProfileId: string
): Promise<ConsultantPayoutEligibility> {
  // Get ready earnings amount
  const readyEarnings = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    _sum: { consultantShare: true },
  });

  const readyAmount = readyEarnings._sum.consultantShare || 0;

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
 */
export async function createPayoutBatch(
  consultantProfileIds?: string[]
): Promise<string> {
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
    _sum: { consultantShare: true },
    having: {
      consultantShare: {
        _sum: { gte: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT },
      },
    },
  });

  // Create payouts for each eligible consultant
  for (const consultant of eligibleConsultants) {
    const { consultantProfileId, _sum } = consultant;
    const amount = _sum?.consultantShare || 0;

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
        `No verified payout account for consultant ${consultantProfileId}`
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

    // Determine if auto-approve applies
    const shouldAutoApprove = amount < PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD;

    // Create payout record
    const payout = await prisma.payout.create({
      data: {
        consultantProfileId,
        provider: account.provider,
        amount,
        currency: "INR",
        status: shouldAutoApprove ? PayoutStatus.APPROVED : PayoutStatus.PENDING,
        method,
        batchId,
        idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
        approvedAt: shouldAutoApprove ? new Date() : undefined,
        approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
      },
    });

    // Link earnings to this payout
    await prisma.consultantEarnings.updateMany({
      where: {
        consultantProfileId,
        status: EarningStatus.READY,
        payoutId: null,
      },
      data: {
        payoutId: payout.id,
      },
    });
  }

  return batchId;
}

/**
 * Approve a payout (admin action)
 */
export async function approvePayout(
  payoutId: string,
  adminUserId: string
): Promise<void> {
  await prisma.payout.update({
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
 */
export async function rejectPayout(
  payoutId: string,
  reason: string
): Promise<void> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { earnings: true },
  });

  if (!payout) {
    throw new Error("Payout not found");
  }

  // Unlink earnings and set them back to READY
  await prisma.consultantEarnings.updateMany({
    where: { payoutId },
    data: {
      payoutId: null,
    },
  });

  // Cancel the payout
  await prisma.payout.update({
    where: { id: payoutId },
    data: {
      status: PayoutStatus.CANCELLED,
      failureReason: reason,
    },
  });
}

/**
 * Process all approved payouts
 */
export async function processApprovedPayouts(): Promise<PayoutResult[]> {
  const approvedPayouts = await prisma.payout.findMany({
    where: { status: PayoutStatus.APPROVED },
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
    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: PayoutStatus.PROCESSING },
    });

    const account = payout.consultantProfile.payoutAccounts[0];
    if (!account) {
      throw new Error("No payout account found");
    }

    let providerPayoutId: string | undefined;

    if (payout.provider === PaymentGateway.RAZORPAY) {
      providerPayoutId = await processRazorpayPayout(payout, account);
    } else if (payout.provider === PaymentGateway.STRIPE) {
      providerPayoutId = await processStripePayout(payout, account);
    } else {
      throw new Error(`Unsupported provider: ${payout.provider}`);
    }

    // Update payout with provider ID
    await prisma.payout.update({
      where: { id: payout.id },
      data: {
        providerPayoutId,
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
    await prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: errorMessage,
        retryCount: { increment: 1 },
      },
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
  }
): Promise<string> {
  if (!isRazorpayPayoutsConfigured()) {
    throw new Error("RazorpayX Payouts not configured");
  }

  if (!account.razorpayFundAccId) {
    throw new Error("Razorpay fund account not found");
  }

  const razorpayPayouts = getRazorpayPayoutsService();

  // Determine payout mode
  const mode = razorpayPayouts.determinePayoutMode(
    payout.amount,
    account.accountType === "UPI" ? "vpa" : "bank_account"
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
  }
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
 */
export async function handlePayoutWebhook(
  _provider: PaymentGateway,
  providerPayoutId: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED",
  failureReason?: string
): Promise<void> {
  const payout = await prisma.payout.findFirst({
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

  // Update payout status
  await prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: payoutStatus,
      processedAt:
        payoutStatus === PayoutStatus.COMPLETED ? new Date() : undefined,
      failureReason: failureReason,
    },
  });

  // If completed, update earnings and consultant stats
  if (payoutStatus === PayoutStatus.COMPLETED) {
    // Update earnings to PAID
    await prisma.consultantEarnings.updateMany({
      where: { payoutId: payout.id },
      data: {
        status: EarningStatus.PAID,
        paidAt: new Date(),
      },
    });

    // Update consultant stats
    await prisma.consultantProfile.update({
      where: { id: payout.consultantProfileId },
      data: {
        totalRevenue: { increment: payout.amount },
        pendingRevenue: { decrement: payout.amount },
      },
    });
  }

  // If failed, unlink earnings so they can be included in next batch
  if (payoutStatus === PayoutStatus.FAILED) {
    await prisma.consultantEarnings.updateMany({
      where: { payoutId: payout.id },
      data: {
        payoutId: null,
      },
    });
  }
}

/**
 * Get payout statistics for dashboard
 */
export async function getPayoutStats() {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.payout.aggregate({
      where: { status: PayoutStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { status: PayoutStatus.COMPLETED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
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
