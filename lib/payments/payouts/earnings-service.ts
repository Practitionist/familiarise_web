/**
 * Earnings Service
 * Manages consultant and organization earnings from payments.
 *
 * For PROVIDER/HYBRID orgs, implements a 3-way revenue split:
 *   Payment (100%) = Platform fee (configurable, default 10%)
 *                   + Org retain (configurable, default 5%)
 *                   + Consultant payout (configurable, default 85%)
 *
 * The split is controlled by OrganizationProfile rates and can be overridden
 * per-consultant via OrganizationMemberProfile.customConsultantPayoutRate.
 *
 * When earningsRecipient = ORGANIZATION, the consultant's share is redirected
 * to the org (internal/salaried consultant case).
 */

import prisma from "@/lib/prisma";
import {
  EarningRole,
  EarningStatus,
  EarningsRecipient,
  Payment,
  Prisma,
} from "@prisma/client";
import { PAYOUT_CONSTANTS, AppointmentType } from "./constants";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { getIndianFYQuarter } from "@/lib/payments/tax/tds-service";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import type { RevenueSplit } from "@/types/collaborators";

// ============================================
// Types
// ============================================

export interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

/** Resolved 3-way split for a PROVIDER/HYBRID org consultant */
export interface OrgEarningsSplit {
  organizationProfileId: string;
  platformFee: number; // in paise
  orgShare: number; // in paise (org retains this)
  consultantShare: number; // in paise (goes to consultant, or 0 if internal)
  earningsRecipient: EarningsRecipient;
}

/** Summary of an org's earnings across all statuses */
export interface OrgEarningsSummary {
  organizationProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

export interface CreateEarningsParams {
  payment: Payment & {
    appointment?: {
      consultantProfile?: {
        id: string;
      };
      webinar?: {
        webinarPlanId: string;
      } | null;
      class?: {
        classPlanId: string;
      } | null;
    } | null;
  };
  appointmentType: AppointmentType;
}

// ============================================
// Org Split Resolution
// ============================================

type PrismaTransaction = Prisma.TransactionClient;

/**
 * Determine if a consultant's payment should use a 3-way org split.
 *
 * Returns an OrgEarningsSplit if the consultant is an active ORG_CONSULTANT
 * in a PROVIDER/HYBRID org. Returns null for independent consultants or
 * when the PROVIDER feature flag is off.
 *
 * For multi-org consultants, uses the first active PROVIDER/HYBRID membership.
 * (Future: allow consultant to select which org gets credit per-booking.)
 */
async function resolveOrgSplit(
  tx: PrismaTransaction,
  consultantProfileId: string,
  grossAmount: number,
): Promise<OrgEarningsSplit | null> {
  if (!ENABLE_PROVIDER_ORGS) return null;

  const orgMembership = await tx.organizationMemberProfile.findFirst({
    where: {
      consultantProfileId,
      role: "ORG_CONSULTANT",
      status: "ACTIVE",
      organizationProfile: {
        kind: { in: ["PROVIDER", "HYBRID"] },
        status: "ACTIVE",
      },
    },
    include: {
      organizationProfile: {
        select: {
          id: true,
          platformCommissionRate: true,
          orgRetainRate: true,
          consultantPayoutRate: true,
        },
      },
    },
  });

  if (!orgMembership) return null;

  const org = orgMembership.organizationProfile;
  const earningsRecipient = orgMembership.earningsRecipient;

  // Determine effective consultant rate (per-member override or org default)
  const effectiveConsultantRate =
    orgMembership.customConsultantPayoutRate ?? org.consultantPayoutRate;

  // Calculate splits in paise (integer arithmetic to avoid float rounding)
  const platformFee = Math.round(grossAmount * org.platformCommissionRate);

  if (earningsRecipient === "ORGANIZATION") {
    // Internal/salaried consultant: org captures everything except platform fee
    return {
      organizationProfileId: org.id,
      platformFee,
      orgShare: grossAmount - platformFee,
      consultantShare: 0,
      earningsRecipient,
    };
  }

  // Standard PROVIDER split: platform + org retain + consultant
  const consultantShare = Math.round(grossAmount * effectiveConsultantRate);
  const orgShare = grossAmount - platformFee - consultantShare;

  return {
    organizationProfileId: org.id,
    platformFee,
    orgShare,
    consultantShare,
    earningsRecipient,
  };
}

// ============================================
// Earnings Service Functions
// ============================================

/**
 * Create earnings record from a successful payment
 * Called from payment success webhook
 */
export async function createEarningsFromPayment({
  payment,
  appointmentType,
}: CreateEarningsParams): Promise<string | null> {
  // Get consultant profile ID from the appointment
  const consultantProfileId = payment.appointment?.consultantProfile?.id;

  if (!consultantProfileId) {
    console.warn(
      `No consultant profile found for payment ${payment.id}. Skipping earnings creation.`,
    );
    return null;
  }

  // Calculate revenue split using original plan price (before platform-funded discounts/credits/tax)
  // Payment.originalAmount is stored in paise (smallest unit) — same as earnings
  const grossAmount = payment.originalAmount;

  // Calculate hold period
  const holdHours =
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION;
  const holdUntil = new Date(Date.now() + holdHours * 60 * 60 * 1000);

  // Determine if this payment involves collaborators (webinars/classes only)
  let planType: "webinar" | "class" | null = null;
  let planId: string | null = null;

  if (appointmentType === "WEBINAR" && payment.appointment?.webinar) {
    planType = "webinar";
    planId = payment.appointment.webinar.webinarPlanId;
  } else if (appointmentType === "CLASS" && payment.appointment?.class) {
    planType = "class";
    planId = payment.appointment.class.classPlanId;
  }

  // FIX #9: Wrap earnings creation + balance updates in a transaction for atomicity.
  // Also handles P2002 unique constraint violations gracefully for idempotency.
  try {
    return await prisma.$transaction(async (tx) => {
      // Idempotency check inside transaction to prevent races
      const existingEarnings = await tx.consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      if (existingEarnings) {
        console.warn(
          `Earnings already exist for payment ${payment.id}. Skipping.`,
        );
        return existingEarnings.id;
      }

      // Check if this consultant belongs to a PROVIDER/HYBRID org (3-way split)
      const orgSplit = await resolveOrgSplit(
        tx,
        consultantProfileId,
        grossAmount,
      );

      // Determine platform fee and consultant pool based on whether org split applies
      const platformFee = orgSplit
        ? orgSplit.platformFee
        : Math.round(
            (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
          );
      const totalConsultantPool = orgSplit
        ? orgSplit.consultantShare
        : grossAmount - platformFee;

      // Calculate collaborator splits if applicable
      let splits: RevenueSplit[] = [];
      if (planType && planId) {
        splits = await calculateRevenueSplit(
          planType,
          planId,
          totalConsultantPool,
        );
      }

      let ownerId: string | null = null;

      if (splits.length > 0) {
        // Multi-party payment: create earnings for owner and each collaborator
        for (const split of splits) {
          const isOwner = split.role === "OWNER";
          const sharePercentage =
            totalConsultantPool > 0
              ? (split.share / totalConsultantPool) * 100
              : 0;

          const earnings = await tx.consultantEarnings.create({
            data: {
              consultantProfileId: split.consultantProfileId,
              paymentId: payment.id,
              grossAmount: isOwner ? grossAmount : 0,
              platformFee: isOwner ? platformFee : 0,
              consultantShare: split.share,
              role: isOwner ? EarningRole.OWNER : EarningRole.COLLABORATOR,
              sharePercentage: Math.round(sharePercentage * 100) / 100,
              status: EarningStatus.PENDING,
              holdUntil,
              currency: "INR",
            },
          });

          if (split.share > 0) {
            await tx.consultantProfile.update({
              where: { id: split.consultantProfileId },
              data: {
                pendingRevenue: { increment: split.share },
              },
            });
          }

          if (split.role === "OWNER") {
            ownerId = earnings.id;
          }

          console.log(
            `Earnings created for ${split.role} (${split.consultantProfileId}): ${split.share / 100} from payment ${payment.id}${orgSplit ? " [PROVIDER 3-way split]" : ""}`,
          );
        }
      } else {
        // Single-owner payment (no collaborators or not a webinar/class)
        const earnings = await tx.consultantEarnings.create({
          data: {
            consultantProfileId,
            paymentId: payment.id,
            grossAmount,
            platformFee,
            consultantShare: totalConsultantPool,
            status: EarningStatus.PENDING,
            holdUntil,
            currency: "INR",
          },
        });

        if (totalConsultantPool > 0) {
          await tx.consultantProfile.update({
            where: { id: consultantProfileId },
            data: {
              pendingRevenue: { increment: totalConsultantPool },
            },
          });
        }

        ownerId = earnings.id;
      }

      // Create OrganizationEarnings row for the PROVIDER/HYBRID org (3-way split).
      // Skip when orgShare is 0 (Platform-only mode: platformCommissionRate = 1.0)
      // — creating 0-value rows adds noise without value.
      if (orgSplit && orgSplit.orgShare > 0) {
        await tx.organizationEarnings.create({
          data: {
            organizationProfileId: orgSplit.organizationProfileId,
            paymentId: payment.id,
            grossAmount,
            platformFee: orgSplit.platformFee,
            orgShare: orgSplit.orgShare,
            refundedAmount: 0,
            status: EarningStatus.PENDING,
            holdUntil,
            currency: "INR",
          },
        });

        console.log(
          `Org earnings created for ${orgSplit.organizationProfileId}: org=${orgSplit.orgShare / 100} consultant=${orgSplit.consultantShare / 100} (recipient=${orgSplit.earningsRecipient}) from payment ${payment.id}`,
        );
      } else if (orgSplit && orgSplit.orgShare === 0) {
        console.log(
          `Platform-only mode for ${orgSplit.organizationProfileId}: skipping 0-value org earnings for payment ${payment.id}`,
        );
      }

      return ownerId;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Unique constraint violation — earnings already created by a concurrent call
      console.warn(
        `[Earnings] Duplicate earnings creation for payment ${payment.id} (P2002). Treating as idempotent success.`,
      );
      const existing = await prisma.consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      return existing?.id ?? null;
    }
    throw error;
  }
}

/**
 * Release earnings from hold period
 * Called by cron job hourly
 */
export async function releaseEarningsFromHold(): Promise<number> {
  const now = new Date();

  // Release consultant earnings
  const consultantResult = await prisma.consultantEarnings.updateMany({
    where: {
      status: EarningStatus.PENDING,
      holdUntil: { lte: now },
    },
    data: {
      status: EarningStatus.READY,
    },
  });

  // Release org earnings in parallel
  const orgResult = await prisma.organizationEarnings.updateMany({
    where: {
      status: EarningStatus.PENDING,
      holdUntil: { lte: now },
    },
    data: {
      status: EarningStatus.READY,
    },
  });

  const total = consultantResult.count + orgResult.count;
  console.log(
    `Released ${consultantResult.count} consultant + ${orgResult.count} org earnings from hold`,
  );
  return total;
}

/**
 * Get consultant earnings summary
 */
export async function getConsultantEarningsSummary(
  consultantProfileId: string,
): Promise<EarningsSummary> {
  const [pending, ready, paid, held] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.PENDING },
      _sum: { consultantShare: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.READY },
      _sum: { consultantShare: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.PAID },
      _sum: { consultantShare: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.HELD },
      _sum: { consultantShare: true },
    }),
  ]);

  const pendingEarnings = pending._sum.consultantShare || 0;
  const readyEarnings = ready._sum.consultantShare || 0;
  const paidEarnings = paid._sum.consultantShare || 0;
  const heldEarnings = held._sum.consultantShare || 0;

  return {
    consultantProfileId,
    totalEarnings:
      pendingEarnings + readyEarnings + paidEarnings + heldEarnings,
    pendingEarnings,
    readyEarnings,
    paidEarnings,
    heldEarnings,
  };
}

/**
 * Get consultant earnings with pagination and filters
 */
export async function getConsultantEarnings(
  consultantProfileId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
  },
) {
  const { status, limit = 20, offset = 0 } = options || {};

  const [earnings, total] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            appointment: {
              select: {
                id: true,
                appointmentType: true,
              },
            },
          },
        },
        payout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.consultantEarnings.count({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Refund earnings (called when a payment is refunded)
 */
export async function refundEarnings(
  paymentId: string,
  options?: {
    forceRefund?: boolean;
    /** For partial refunds: the refund amount in smallest currency unit */
    refundAmount?: number;
    /** For partial refunds: the original payment amount in smallest currency unit */
    paymentAmount?: number;
  },
): Promise<boolean> {
  const allEarnings = await prisma.consultantEarnings.findMany({
    where: { paymentId },
  });

  if (allEarnings.length === 0) {
    console.warn(`No earnings found for payment ${paymentId}`);
    return false;
  }

  // Calculate refund ratio for partial refunds.
  // If refundAmount < paymentAmount, only reverse a proportional share of earnings.
  // Handle edge case: refundAmount=0 means no reversal (ratio=0).
  const isPartialRefund =
    options?.refundAmount !== null &&
    options?.refundAmount !== undefined &&
    options?.paymentAmount !== null &&
    options?.paymentAmount !== undefined &&
    options.paymentAmount > 0 &&
    options.refundAmount < options.paymentAmount;
  const refundRatio = isPartialRefund
    ? options!.refundAmount! / options!.paymentAmount!
    : options?.refundAmount === 0
      ? 0
      : 1;

  if (refundRatio === 0) {
    console.log(`Zero-amount refund for payment ${paymentId}, no earnings reversal needed`);
    return true;
  }

  if (isPartialRefund) {
    console.log(
      `Partial refund: ${options!.refundAmount}/${options!.paymentAmount} = ${(refundRatio * 100).toFixed(1)}% reversal for payment ${paymentId}`,
    );
  }

  // Also refund any org earnings for this payment (PROVIDER 3-way split)
  const orgEarnings = await prisma.organizationEarnings.findMany({
    where: { paymentId },
  });

  for (const orgEarning of orgEarnings) {
    if (orgEarning.status === EarningStatus.REFUNDED) continue;

    const alreadyRefunded = orgEarning.refundedAmount ?? 0;
    const maxReversible = Math.max(0, orgEarning.orgShare - alreadyRefunded);
    const rawOrgRefund = Math.round(orgEarning.orgShare * refundRatio);
    const orgRefundAmount = Math.min(rawOrgRefund, maxReversible);

    if (orgRefundAmount <= 0) continue;

    const isOrgFullyRefunded =
      alreadyRefunded + orgRefundAmount >= orgEarning.orgShare;

    await prisma.organizationEarnings.update({
      where: { id: orgEarning.id },
      data: {
        refundedAmount: { increment: orgRefundAmount },
        ...(isOrgFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    console.log(
      `Org earnings ${orgEarning.id} refunded: ${orgRefundAmount} paise (${isOrgFullyRefunded ? "full" : "partial"})`,
    );
  }

  // Refund each earnings record (supports multi-party collaborator payments)
  for (const earnings of allEarnings) {
    // C7 FIX: Guard against already-refunded earnings.
    if (earnings.status === EarningStatus.REFUNDED) {
      console.warn(
        `Earnings ${earnings.id} already refunded for payment ${paymentId}. Skipping.`,
      );
      continue;
    }

    // Cap shareToReverse against remaining reversible balance to prevent
    // over-refunding on duplicate webhooks or sequential partial refunds.
    const alreadyRefunded = earnings.refundedShareAmount ?? 0;
    const maxReversible = Math.max(0, earnings.consultantShare - alreadyRefunded);
    const rawShare = Math.round(earnings.consultantShare * refundRatio);
    const shareToReverse = Math.min(rawShare, maxReversible);

    if (shareToReverse <= 0) {
      console.warn(
        `Earnings ${earnings.id} already fully refunded (${alreadyRefunded}/${earnings.consultantShare}). Skipping.`,
      );
      continue;
    }

    // Determine if this reversal fully exhausts the earning
    const isFullyRefunded = alreadyRefunded + shareToReverse >= earnings.consultantShare;

    // Handle already-paid earnings (payout completed)
    if (earnings.status === EarningStatus.PAID) {
      if (!options?.forceRefund) {
        console.error(
          `Cannot refund earnings ${earnings.id} - already paid out. Use forceRefund: true to proceed with TDS reversal.`,
        );
        continue;
      }

      // Force refund of PAID earnings: create TDS reversal record
      if (earnings.payoutId) {
        const tdsRecord = await prisma.tDSRecord.findFirst({
          where: {
            payoutId: earnings.payoutId,
            consultantProfileId: earnings.consultantProfileId,
            isReversal: false,
          },
        });

        if (tdsRecord && tdsRecord.tdsDeducted > 0) {
          const tdsToReverse = Math.round(tdsRecord.tdsDeducted * refundRatio);
          await prisma.tDSRecord.create({
            data: {
              consultantProfileId: earnings.consultantProfileId,
              financialYear: tdsRecord.financialYear,
              quarter: getIndianFYQuarter(),
              cumulativeAmountCredited: tdsRecord.cumulativeAmountCredited,
              tdsDeducted: -tdsToReverse,
              tdsRate: tdsRecord.tdsRate,
              payoutId: earnings.payoutId,
              earningsId: earnings.id,
              isReversal: true,
            },
          });

          console.log(
            `TDS reversal created for earnings ${earnings.id}: -${tdsToReverse} paise (${isPartialRefund ? "partial" : "full"})`,
          );
        }
      }

      // Update earnings: always track refundedShareAmount, set REFUNDED when fully exhausted
      await prisma.consultantEarnings.update({
        where: { id: earnings.id },
        data: {
          refundedShareAmount: { increment: shareToReverse },
          ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
        },
      });

      // For PAID earnings, decrement totalRevenue (not pendingRevenue — already paid)
      await prisma.consultantProfile.update({
        where: { id: earnings.consultantProfileId },
        data: { totalRevenue: { decrement: shareToReverse } },
      });

      continue;
    }

    // Update earnings for non-paid earnings (PENDING/HELD/READY):
    // always track refundedShareAmount, set REFUNDED when fully exhausted
    await prisma.consultantEarnings.update({
      where: { id: earnings.id },
      data: {
        refundedShareAmount: { increment: shareToReverse },
        ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    // Decrease consultant's pending revenue by the capped share
    await prisma.consultantProfile.update({
      where: { id: earnings.consultantProfileId },
      data: {
        pendingRevenue: { decrement: shareToReverse },
      },
    });
  }

  return true;
}

/**
 * Hold earnings (e.g., for dispute investigation)
 */
export async function holdEarnings(
  earningsId: string,
  reason?: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings) {
    console.warn(`Earnings not found: ${earningsId}`);
    return false;
  }

  // Can only hold if pending or ready
  if (
    earnings.status !== EarningStatus.PENDING &&
    earnings.status !== EarningStatus.READY
  ) {
    console.warn(
      `Cannot hold earnings ${earningsId} - status is ${earnings.status}`,
    );
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.HELD,
    },
  });

  console.log(
    `Earnings ${earningsId} held. Reason: ${reason || "Not specified"}`,
  );
  return true;
}

/**
 * Release held earnings back to ready state
 */
export async function releaseHeldEarnings(
  earningsId: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings || earnings.status !== EarningStatus.HELD) {
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.READY,
    },
  });

  return true;
}

/**
 * Get earnings statistics for admin dashboard
 */
export async function getEarningsStats() {
  const [pending, ready, paid, held, refunded] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantShare: true, platformFee: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantShare: true, platformFee: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PAID },
      _sum: { consultantShare: true, platformFee: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.HELD },
      _sum: { consultantShare: true, platformFee: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.REFUNDED },
      _sum: { consultantShare: true, platformFee: true },
      _count: true,
    }),
  ]);

  return {
    pending: {
      count: pending._count,
      consultantShare: pending._sum.consultantShare || 0,
      platformFee: pending._sum.platformFee || 0,
    },
    ready: {
      count: ready._count,
      consultantShare: ready._sum.consultantShare || 0,
      platformFee: ready._sum.platformFee || 0,
    },
    paid: {
      count: paid._count,
      consultantShare: paid._sum.consultantShare || 0,
      platformFee: paid._sum.platformFee || 0,
    },
    held: {
      count: held._count,
      consultantShare: held._sum.consultantShare || 0,
      platformFee: held._sum.platformFee || 0,
    },
    refunded: {
      count: refunded._count,
      consultantShare: refunded._sum.consultantShare || 0,
      platformFee: refunded._sum.platformFee || 0,
    },
    totalPlatformRevenue:
      (paid._sum.platformFee || 0) + (ready._sum.platformFee || 0),
  };
}

// ============================================
// Organization Earnings Functions
// ============================================

/**
 * Get org earnings summary (parallels getConsultantEarningsSummary)
 */
export async function getOrgEarningsSummary(
  organizationProfileId: string,
): Promise<OrgEarningsSummary> {
  const [pending, ready, paid, held] = await Promise.all([
    prisma.organizationEarnings.aggregate({
      where: { organizationProfileId, status: EarningStatus.PENDING },
      _sum: { orgShare: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationProfileId, status: EarningStatus.READY },
      _sum: { orgShare: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationProfileId, status: EarningStatus.PAID },
      _sum: { orgShare: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationProfileId, status: EarningStatus.HELD },
      _sum: { orgShare: true },
    }),
  ]);

  const pendingEarnings = pending._sum.orgShare || 0;
  const readyEarnings = ready._sum.orgShare || 0;
  const paidEarnings = paid._sum.orgShare || 0;
  const heldEarnings = held._sum.orgShare || 0;

  return {
    organizationProfileId,
    totalEarnings:
      pendingEarnings + readyEarnings + paidEarnings + heldEarnings,
    pendingEarnings,
    readyEarnings,
    paidEarnings,
    heldEarnings,
  };
}

/**
 * Get paginated org earnings list
 */
export async function getOrgEarnings(
  organizationProfileId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
  },
) {
  const { status, limit = 20, offset = 0 } = options || {};

  const [earnings, total] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        organizationProfileId,
        ...(status ? { status } : {}),
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            appointment: {
              select: {
                id: true,
                appointmentType: true,
              },
            },
          },
        },
        orgPayout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.organizationEarnings.count({
      where: {
        organizationProfileId,
        ...(status ? { status } : {}),
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}
