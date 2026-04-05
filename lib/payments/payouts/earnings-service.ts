/**
 * Earnings Service
 * Manages consultant earnings from payments
 */

import prisma from "@/lib/prisma";
import { EarningRole, EarningStatus, Payment, Prisma } from "@prisma/client";
import { PAYOUT_CONSTANTS, AppointmentType } from "./constants";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { getIndianFYQuarter } from "@/lib/payments/tax/tds-service";

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
  const platformFee = Math.round(
    (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
  );
  const totalConsultantPool = grossAmount - platformFee;

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

  // Calculate collaborator splits if applicable
  let splits: { consultantProfileId: string; share: number; role: string }[] =
    [];
  if (planType && planId) {
    splits = await calculateRevenueSplit(planType, planId, totalConsultantPool);
  }

  // FIX #9: Wrap earnings creation + balance updates in a transaction for atomicity.
  // Also handles P2002 unique constraint violations gracefully for idempotency.
  try {
    if (splits.length > 0) {
      // Multi-party payment: create earnings for owner and each collaborator atomically
      const ownerEarningsId = await prisma.$transaction(async (tx) => {
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

        let ownerId: string | null = null;

        for (const split of splits) {
          const isOwner = split.role === "OWNER";
          const sharePercentage = (split.share / totalConsultantPool) * 100;

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
              currency: "INR", // Explicit — all earnings in INR for MVP
            },
          });

          await tx.consultantProfile.update({
            where: { id: split.consultantProfileId },
            data: {
              pendingRevenue: { increment: split.share },
            },
          });

          if (split.role === "OWNER") {
            ownerId = earnings.id;
          }

          console.log(
            `💰 Earnings created for ${split.role} (${split.consultantProfileId}): ₹${split.share / 100} from payment ${payment.id}`,
          );
        }

        return ownerId;
      });

      return ownerEarningsId;
    } else {
      // Single-owner payment (no collaborators or not a webinar/class)
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

        const earnings = await tx.consultantEarnings.create({
          data: {
            consultantProfileId,
            paymentId: payment.id,
            grossAmount,
            platformFee,
            consultantShare: totalConsultantPool,
            status: EarningStatus.PENDING,
            holdUntil,
            currency: "INR", // Explicit — all earnings in INR for MVP
          },
        });

        await tx.consultantProfile.update({
          where: { id: consultantProfileId },
          data: {
            pendingRevenue: { increment: totalConsultantPool },
          },
        });

        return earnings.id;
      });
    }
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

  // Find all earnings that are past their hold period
  const result = await prisma.consultantEarnings.updateMany({
    where: {
      status: EarningStatus.PENDING,
      holdUntil: { lte: now },
    },
    data: {
      status: EarningStatus.READY,
    },
  });

  console.log(`Released ${result.count} earnings from hold`);
  return result.count;
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
