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
 * Find succeeded payments without earnings and create them
 */
export async function syncPaymentEarnings(): Promise<PaymentEarningSyncResult> {
  const errors: string[] = [];
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const thirtyDaysAgo = new Date(
    Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  // Find all succeeded payments without earnings records
  const paymentsWithoutEarnings = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      createdAt: { gte: thirtyDaysAgo },
      earnings: null, // No linked earnings
    },
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

  console.log(
    `Found ${paymentsWithoutEarnings.length} succeeded payments without earnings records`,
  );

  for (const payment of paymentsWithoutEarnings) {
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

    // Double-check earnings don't exist (in case of race condition)
    const existingEarnings = await prisma.consultantEarnings.findUnique({
      where: { paymentId: payment.id },
    });

    if (existingEarnings) {
      console.log(`⏭️ Skipping payment ${payment.id} - earnings already exist`);
      skippedCount++;
      continue;
    }

    try {
      // Calculate revenue split
      const grossAmount = payment.amount;
      const platformFee = Math.round(
        (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
      );
      const consultantShare = grossAmount - platformFee;

      // Get appointment type for hold period
      const appointmentType = appointment?.appointmentType
        ? mapAppointmentType(appointment.appointmentType)
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

      // Create earnings record
      const earnings = await prisma.consultantEarnings.create({
        data: {
          consultantProfileId,
          paymentId: payment.id,
          grossAmount,
          platformFee,
          consultantShare,
          status,
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

      console.log(
        `✅ Created earnings ${earnings.id} for payment ${payment.id} (status: ${status}, amount: ₹${(consultantShare / 100).toFixed(2)})`,
      );
      createdCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Payment ${payment.id}: ${errorMessage}`);
      console.error(
        `❌ Error creating earnings for payment ${payment.id}:`,
        errorMessage,
      );
      errorCount++;
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: paymentsWithoutEarnings.length,
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
