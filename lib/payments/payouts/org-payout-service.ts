/**
 * Organization Payout Service
 *
 * Manages payout batch creation and processing for PROVIDER/HYBRID orgs.
 * Aggregates READY OrganizationEarnings into OrganizationPayout batches
 * and processes them via Razorpay/Stripe.
 *
 * Mirrors the consultant payout pipeline in payout-service.ts.
 */

import prisma from "@/lib/prisma";
import { EarningStatus, PayoutStatus, Prisma } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { PAYOUT_CONSTANTS } from "./constants";

// ============================================
// Types
// ============================================

export interface OrgPayoutEligibility {
  eligible: boolean;
  readyAmount: number; // in paise
  earningsCount: number;
  reason?: string;
}

export interface OrgPayoutBatchResult {
  payoutId: string;
  amount: number;
  earningsCount: number;
  periodStart: Date;
  periodEnd: Date;
}

// ============================================
// Payout Batch Creation
// ============================================

const LOCK_TTL_MS = 30_000; // 30 seconds

/**
 * Check if an org is eligible for a payout batch.
 */
export async function getOrgPayoutEligibility(
  orgProfileId: string,
): Promise<OrgPayoutEligibility> {
  // Check payout account exists and is verified
  const payoutAccount = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationProfileId: orgProfileId },
  });

  if (!payoutAccount) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      reason: "No payout account configured.",
    };
  }

  if (payoutAccount.status !== "VERIFIED") {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      reason: `Payout account is ${payoutAccount.status}. Must be VERIFIED.`,
    };
  }

  // Aggregate ready earnings
  const agg = await prisma.organizationEarnings.aggregate({
    where: {
      organizationProfileId: orgProfileId,
      status: EarningStatus.READY,
      orgPayoutId: null,
    },
    _sum: { orgShare: true },
    _count: true,
  });

  const readyAmount = agg._sum.orgShare || 0;
  const earningsCount = agg._count;

  if (earningsCount === 0) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      reason: "No earnings ready for payout.",
    };
  }

  if (readyAmount < PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT) {
    return {
      eligible: false,
      readyAmount,
      earningsCount,
      reason: `Ready amount (${readyAmount / 100}) is below minimum payout threshold (${PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT / 100}).`,
    };
  }

  return { eligible: true, readyAmount, earningsCount };
}

/**
 * Create a payout batch for an org by aggregating all READY earnings.
 *
 * Uses a distributed lock to prevent concurrent batch creation for the same org.
 */
export async function createOrgPayoutBatch(
  orgProfileId: string,
  periodEnd: Date = new Date(),
): Promise<OrgPayoutBatchResult> {
  const lockKey = `org-payout:${orgProfileId}`;
  const lockToken = await acquireLock(lockKey, LOCK_TTL_MS);

  if (!lockToken) {
    throw new Error(
      "Another payout batch is being created for this organization. Please try again.",
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Find all ready, unbatched earnings
      const readyEarnings = await tx.organizationEarnings.findMany({
        where: {
          organizationProfileId: orgProfileId,
          status: EarningStatus.READY,
          orgPayoutId: null,
        },
        orderBy: { createdAt: "asc" },
      });

      if (readyEarnings.length === 0) {
        throw new Error("No earnings ready for payout.");
      }

      // Calculate totals
      const grossRevenue = readyEarnings.reduce(
        (sum, e) => sum + e.grossAmount,
        0,
      );
      const platformFee = readyEarnings.reduce(
        (sum, e) => sum + e.platformFee,
        0,
      );
      const totalOrgShare = readyEarnings.reduce(
        (sum, e) => sum + e.orgShare,
        0,
      );
      const refunds = readyEarnings.reduce(
        (sum, e) => sum + e.refundedAmount,
        0,
      );
      const netPayout = totalOrgShare - refunds;

      if (netPayout < PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT) {
        throw new Error(
          `Net payout amount (${netPayout / 100}) is below minimum threshold (${PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT / 100}).`,
        );
      }

      // Find the earliest earning date for period start
      const periodStart =
        readyEarnings[0]?.createdAt ?? new Date(periodEnd.getTime() - 86400000);

      // Determine payment gateway from payout account
      const payoutAccount = await tx.organizationPayoutAccount.findUnique({
        where: { organizationProfileId: orgProfileId },
      });

      if (!payoutAccount || payoutAccount.status !== "VERIFIED") {
        throw new Error("Payout account must be verified before creating a payout batch.");
      }

      const paymentGateway = payoutAccount.razorpayContactId
        ? "RAZORPAY"
        : payoutAccount.stripeConnectId
          ? "STRIPE"
          : "RAZORPAY"; // default

      // Create the payout record
      const payout = await tx.organizationPayout.create({
        data: {
          organizationProfileId: orgProfileId,
          amount: netPayout,
          currency: "INR",
          status: PayoutStatus.PENDING,
          paymentGateway,
          periodStart,
          periodEnd,
          grossRevenue,
          platformFee,
          refunds,
          netPayout,
        },
      });

      // Link all earnings to this payout
      await tx.organizationEarnings.updateMany({
        where: {
          id: { in: readyEarnings.map((e) => e.id) },
        },
        data: {
          orgPayoutId: payout.id,
        },
      });

      // Audit log
      await tx.orgAuditLog.create({
        data: {
          organizationProfileId: orgProfileId,
          actorMemberId: null, // system-initiated or set by caller
          action: "PAYOUT_INITIATED",
          description: `Payout batch created: ${netPayout / 100} INR (${readyEarnings.length} earnings)`,
          details: {
            payoutId: payout.id,
            amount: netPayout,
            earningsCount: readyEarnings.length,
          },
        },
      });

      return {
        payoutId: payout.id,
        amount: netPayout,
        earningsCount: readyEarnings.length,
        periodStart,
        periodEnd,
      };
    });
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

/**
 * Process a pending org payout via the appropriate payment gateway.
 *
 * Updates status: PENDING -> PROCESSING -> COMPLETED/FAILED.
 * On success, marks linked earnings as PAID.
 */
export async function processOrgPayout(payoutId: string): Promise<void> {
  const payout = await prisma.organizationPayout.findUnique({
    where: { id: payoutId },
    include: {
      organizationProfile: {
        include: { payoutAccount: true },
      },
    },
  });

  if (!payout) throw new Error(`Payout ${payoutId} not found.`);
  if (payout.status !== PayoutStatus.PENDING) {
    throw new Error(`Payout ${payoutId} is ${payout.status}, expected PENDING.`);
  }

  const payoutAccount = payout.organizationProfile.payoutAccount;
  if (!payoutAccount || payoutAccount.status !== "VERIFIED") {
    await prisma.organizationPayout.update({
      where: { id: payoutId },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: "Payout account not verified.",
      },
    });
    throw new Error("Payout account not verified.");
  }

  // Set to PROCESSING
  await prisma.organizationPayout.update({
    where: { id: payoutId },
    data: { status: PayoutStatus.PROCESSING },
  });

  try {
    // Gateway dispatch
    if (
      payout.paymentGateway === "RAZORPAY" &&
      payoutAccount.razorpayFundAccountId
    ) {
      const { getRazorpayPayoutsService, isRazorpayPayoutsConfigured } =
        await import("./razorpay-payouts");
      if (isRazorpayPayoutsConfigured()) {
        const service = getRazorpayPayoutsService();
        const result = await service.createPayout({
          fundAccountId: payoutAccount.razorpayFundAccountId,
          amount: payout.amount,
          currency: payout.currency,
          mode: payout.amount >= 20000000 ? "RTGS" : "IMPS",
          purpose: "payout",
          referenceId: payout.id,
          narration: `Familiarise org payout ${payout.id.slice(0, 8)}`,
          idempotencyKey: `org-payout-${payout.id}`,
        });

        await prisma.organizationPayout.update({
          where: { id: payoutId },
          data: {
            payoutReference: result.id,
            status: PayoutStatus.COMPLETED,
            processedAt: new Date(),
          },
        });
      } else {
        // Razorpay not configured — mark as manual
        await prisma.organizationPayout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.COMPLETED,
            processedAt: new Date(),
            failureReason: "RazorpayX not configured — marked as manual.",
          },
        });
      }
    } else if (
      payout.paymentGateway === "STRIPE" &&
      payoutAccount.stripeConnectId
    ) {
      const { getStripeConnectService, isStripeConnectConfigured } =
        await import("./stripe-connect");
      if (isStripeConnectConfigured()) {
        const service = getStripeConnectService();
        const transfer = await service.createTransfer({
          amount: payout.amount,
          currency: payout.currency.toLowerCase(),
          destinationAccountId: payoutAccount.stripeConnectId,
          transferGroup: `org-payout-${payout.id}`,
        });

        await prisma.organizationPayout.update({
          where: { id: payoutId },
          data: {
            payoutReference: transfer.id,
            status: PayoutStatus.COMPLETED,
            processedAt: new Date(),
          },
        });
      }
    } else {
      // No gateway configured — manual payout
      await prisma.organizationPayout.update({
        where: { id: payoutId },
        data: {
          status: PayoutStatus.COMPLETED,
          processedAt: new Date(),
          failureReason: "No payment gateway configured — manual processing.",
        },
      });
    }

    // Mark linked earnings as PAID
    await prisma.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId },
      data: { status: EarningStatus.PAID },
    });

    // Audit log
    await prisma.orgAuditLog.create({
      data: {
        organizationProfileId: payout.organizationProfileId,
        actorMemberId: null,
        action: "PAYOUT_PROCESSED",
        description: `Payout ${payoutId} processed: ${payout.amount / 100} INR`,
        details: { payoutId, amount: payout.amount },
      },
    });

    console.log(
      `Org payout ${payoutId} processed: ${payout.amount / 100} INR`,
    );
  } catch (error) {
    await prisma.organizationPayout.update({
      where: { id: payoutId },
      data: {
        status: PayoutStatus.FAILED,
        failureReason:
          error instanceof Error ? error.message : "Unknown processing error",
      },
    });
    throw error;
  }
}
