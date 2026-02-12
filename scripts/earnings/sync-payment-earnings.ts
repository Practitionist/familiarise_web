/**
 * Payment-Earning Sync - Core Logic
 *
 * Syncs ConsultantEarnings records with Payment records.
 * Finds all payments where status = SUCCEEDED but no corresponding earnings exists.
 * Creates missing earnings records for payments within the last 30 days.
 *
 * This catches cases where:
 * - App crash after payment succeeded but before earnings created
 * - Webhook was missed or delayed
 * - Manual payment processing at gateway
 *
 * This module exports the core sync function.
 * It is imported by:
 * - jobs/sync-payment-earnings.ts (GitHub Actions)
 * - app/api/cleanup/sync-payment-earnings/route.ts (API endpoint)
 *
 * GitHub Issue: #303
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import { EarningStatus, PaymentStatus, AppointmentsType } from "@prisma/client";
import {
  PAYOUT_CONSTANTS,
  AppointmentType,
} from "../../lib/payments/payouts/constants";

// Only sync payments within the last 30 days
const SYNC_WINDOW_DAYS = 30;

// Batch size for processing payments to prevent memory issues
const BATCH_SIZE = 100;

export interface PaymentEarningSyncResult {
  success: boolean;
  totalProcessed: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Map AppointmentsType enum to the payout constants key
 */
function mapAppointmentType(type: AppointmentsType): AppointmentType {
  switch (type) {
    case AppointmentsType.CONSULTATION:
      return "CONSULTATION";
    case AppointmentsType.WEBINAR:
      return "WEBINAR";
    case AppointmentsType.CLASS:
      return "CLASS";
    case AppointmentsType.SUBSCRIPTION:
      return "SUBSCRIPTION";
    default:
      return "CONSULTATION"; // Default to consultation hold period
  }
}

/**
 * Calculate earnings data for a payment
 */
function calculateEarningsData(
  payment: {
    id: string;
    amount: number;
    originalAmount: number | null;
    createdAt: Date;
    appointment: {
      appointmentType: AppointmentsType;
    } | null;
  },
  consultantProfileId: string,
) {
  // Use original amount (before platform-funded discounts/credits) for earnings calculation
  const grossAmount = payment.originalAmount ?? payment.amount;
  const platformFee = Math.round(
    (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
  );
  const consultantShare = grossAmount - platformFee;

  // Get appointment type for hold period
  const appointmentType = payment.appointment?.appointmentType
    ? mapAppointmentType(payment.appointment.appointmentType)
    : "CONSULTATION";

  // Calculate hold period
  const holdHours =
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION;

  // For old payments, check if hold period has already passed
  const paymentAge = Date.now() - payment.createdAt.getTime();
  const holdPeriodMs = holdHours * 60 * 60 * 1000;

  // If payment is older than hold period, set holdUntil in the past (will be released immediately)
  const holdUntil =
    paymentAge > holdPeriodMs
      ? new Date(payment.createdAt.getTime() + holdPeriodMs) // Past date
      : new Date(Date.now() + holdPeriodMs); // Future date

  // Determine status based on whether hold period has passed
  const status =
    paymentAge > holdPeriodMs
      ? EarningStatus.READY // Old payments go straight to READY
      : EarningStatus.PENDING; // Recent payments start as PENDING

  return {
    consultantProfileId,
    paymentId: payment.id,
    grossAmount,
    platformFee,
    consultantShare,
    status,
    holdUntil,
  };
}

/**
 * Find succeeded payments without earnings and create them
 * Uses batch processing to handle large datasets efficiently
 */
export async function syncPaymentEarnings(): Promise<PaymentEarningSyncResult> {
  const errors: string[] = [];
  let totalProcessed = 0;
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const thirtyDaysAgo = new Date(
    Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch batch with limit
    const payments = await prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        createdAt: { gte: thirtyDaysAgo },
        earnings: { none: {} }, // No linked earnings
      },
      take: BATCH_SIZE,
      skip,
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            webinar: {
              include: {
                webinarPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    if (payments.length < BATCH_SIZE) {
      hasMore = false;
    }
    skip += BATCH_SIZE;
    totalProcessed += payments.length;

    if (payments.length === 0) {
      break;
    }

    console.log(
      `Processing batch of ${payments.length} payments (total processed: ${totalProcessed})`,
    );

    // Batch check existing earnings (instead of N individual queries)
    const paymentIds = payments.map((p) => p.id);
    const existingEarnings = await prisma.consultantEarnings.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true },
    });
    const existingPaymentIds = new Set(
      existingEarnings.map((e) => e.paymentId),
    );

    // Prepare earnings to create and revenue updates
    const earningsToCreate: Array<{
      consultantProfileId: string;
      paymentId: string;
      grossAmount: number;
      platformFee: number;
      consultantShare: number;
      status: EarningStatus;
      holdUntil: Date;
    }> = [];
    const revenueUpdates: Map<string, number> = new Map();

    for (const payment of payments) {
      // Skip if earnings already exist
      if (existingPaymentIds.has(payment.id)) {
        console.log(
          `⏭️ Skipping payment ${payment.id} - earnings already exist`,
        );
        skippedCount++;
        continue;
      }

      // Get consultant profile ID from the appointment based on type
      const appointment = payment.appointment;
      const consultantProfileId =
        appointment?.consultation?.consultationPlan?.consultantProfileId ||
        appointment?.subscription?.subscriptionPlan?.consultantProfileId ||
        appointment?.webinar?.webinarPlan?.consultantProfileId ||
        appointment?.class?.classPlan?.consultantProfileId;

      if (!consultantProfileId) {
        console.log(
          `⏭️ Skipping payment ${payment.id} - no consultant profile found`,
        );
        skippedCount++;
        continue;
      }

      const earningsData = calculateEarningsData(payment, consultantProfileId);
      earningsToCreate.push(earningsData);

      // Accumulate revenue updates per consultant
      const currentRevenue = revenueUpdates.get(consultantProfileId) || 0;
      revenueUpdates.set(
        consultantProfileId,
        currentRevenue + earningsData.consultantShare,
      );
    }

    // Batch create earnings
    if (earningsToCreate.length > 0) {
      try {
        const result = await prisma.consultantEarnings.createMany({
          data: earningsToCreate,
          skipDuplicates: true,
        });

        createdCount += result.count;
        console.log(`✅ Created ${result.count} earnings records in batch`);

        // Update consultant revenue balances
        const consultantIds = Array.from(revenueUpdates.keys());
        for (const consultantProfileId of consultantIds) {
          const amount = revenueUpdates.get(consultantProfileId)!;
          try {
            await prisma.consultantProfile.update({
              where: { id: consultantProfileId },
              data: {
                pendingRevenue: { increment: amount },
              },
            });
          } catch (updateError) {
            const errorMessage =
              updateError instanceof Error
                ? updateError.message
                : String(updateError);
            errors.push(
              `Revenue update for consultant ${consultantProfileId}: ${errorMessage}`,
            );
            console.error(
              `❌ Error updating revenue for consultant ${consultantProfileId}:`,
              errorMessage,
            );
            errorCount++;
          }
        }
      } catch (createError) {
        const errorMessage =
          createError instanceof Error
            ? createError.message
            : String(createError);
        errors.push(`Batch create: ${errorMessage}`);
        console.error(`❌ Error creating earnings batch:`, errorMessage);
        errorCount += earningsToCreate.length;
      }
    }
  }

  console.log(
    `Sync complete: ${totalProcessed} total, ${createdCount} created, ${skippedCount} skipped, ${errorCount} errors`,
  );

  return {
    success: errors.length === 0,
    totalProcessed,
    createdCount,
    skippedCount,
    errorCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
