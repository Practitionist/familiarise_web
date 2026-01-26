/**
 * Earnings Service
 * Manages consultant earnings from payments
 */

import prisma from "@/lib/prisma";
import { EarningStatus, Payment } from "@prisma/client";
import { PAYOUT_CONSTANTS, AppointmentType } from "./constants";

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

  // Check if earnings already exist for this payment
  const existingEarnings = await prisma.consultantEarnings.findUnique({
    where: { paymentId: payment.id },
  });

  if (existingEarnings) {
    console.warn(`Earnings already exist for payment ${payment.id}. Skipping.`);
    return existingEarnings.id;
  }

  // Calculate revenue split
  const grossAmount = payment.amount;
  const platformFee = Math.round(
    (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
  );
  const consultantShare = grossAmount - platformFee;

  // Calculate hold period
  const holdHours =
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION;
  const holdUntil = new Date(Date.now() + holdHours * 60 * 60 * 1000);

  // Create earnings record
  const earnings = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId,
      paymentId: payment.id,
      grossAmount,
      platformFee,
      consultantShare,
      status: EarningStatus.PENDING,
      holdUntil,
    },
  });

  // Update consultant's pending revenue
  await prisma.consultantProfile.update({
    where: { id: consultantProfileId },
    data: {
      pendingRevenue: { increment: consultantShare },
    },
  });

  return earnings.id;
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
export async function refundEarnings(paymentId: string): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { paymentId },
  });

  if (!earnings) {
    console.warn(`No earnings found for payment ${paymentId}`);
    return false;
  }

  // Can only refund if not yet paid out
  if (earnings.status === EarningStatus.PAID) {
    console.error(
      `Cannot refund earnings ${earnings.id} - already paid out. Manual intervention required.`,
    );
    return false;
  }

  // Update earnings status to refunded
  await prisma.consultantEarnings.update({
    where: { id: earnings.id },
    data: {
      status: EarningStatus.REFUNDED,
    },
  });

  // Decrease consultant's pending revenue
  await prisma.consultantProfile.update({
    where: { id: earnings.consultantProfileId },
    data: {
      pendingRevenue: { decrement: earnings.consultantShare },
    },
  });

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
