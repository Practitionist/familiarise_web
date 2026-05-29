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
import { EarningStatus, EarningRole, PaymentStatus, AppointmentsType } from "@prisma/client";
import {
  PAYOUT_CONSTANTS,
  AppointmentType,
} from "../../lib/payments/payouts/constants";
import { calculateRevenueSplit } from "../../lib/collaborators/service";

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
    originalAmount: number;
    createdAt: Date;
    appointment: {
      appointmentType: AppointmentsType;
    } | null;
  },
  consultantProfileId: string,
) {
  // Use original plan price (before platform-funded discounts/credits/tax) for earnings
  // Payment.originalAmount is stored in paise (smallest unit) — same as earnings
  const grossAmount = payment.originalAmount;
  const platformFeePaise = Math.round(
    (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
  );
  const consultantSharePaise = grossAmount - platformFeePaise;

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
    platformFeePaise,
    consultantSharePaise,
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

  // FIX #571: Use cursor-based pagination instead of skip-based.
  // Skip-based pagination on a mutating result set (earnings: { none: {} })
  // can silently skip payments when items are removed from the set mid-iteration.
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    // Fetch batch with cursor-based pagination
    const payments = await prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        createdAt: { gte: thirtyDaysAgo },
        earnings: { none: {} }, // No linked earnings
      },
      take: BATCH_SIZE,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 } // skip the cursor item itself
        : {}),
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
                  select: {
                    id: true,
                    consultantProfileId: true,
                  },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  select: {
                    id: true,
                    consultantProfileId: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    if (payments.length < BATCH_SIZE) {
      hasMore = false;
    }
    if (payments.length > 0) {
      cursor = payments[payments.length - 1].id;
    }
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
      platformFeePaise: number;
      consultantSharePaise: number;
      status: EarningStatus;
      holdUntil: Date;
      role?: EarningRole;
      shareBps?: number;
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

      // FIX #572: For webinar/class payments, check for collaborator revenue splits
      // instead of giving 100% to the plan owner.
      const appointmentType = appointment?.appointmentType;
      const webinarPlanId = appointment?.webinar?.webinarPlan?.id;
      const classPlanId = appointment?.class?.classPlan?.id;

      const baseEarnings = calculateEarningsData(payment, consultantProfileId);
      const totalConsultantPool = baseEarnings.consultantSharePaise;

      let splits: Array<{
        consultantProfileId: string;
        share: number;
        role: string;
      }> = [];

      if (
        appointmentType === AppointmentsType.WEBINAR &&
        webinarPlanId
      ) {
        try {
          splits = await calculateRevenueSplit(
            "webinar",
            webinarPlanId,
            totalConsultantPool,
          );
        } catch {
          // Fallback to owner-only if split calculation fails
        }
      } else if (
        appointmentType === AppointmentsType.CLASS &&
        classPlanId
      ) {
        try {
          splits = await calculateRevenueSplit(
            "class",
            classPlanId,
            totalConsultantPool,
          );
        } catch {
          // Fallback to owner-only if split calculation fails
        }
      }

      if (splits.length > 0) {
        // Multi-party earnings (collaborator splits)
        // Owner gets full grossAmount/platformFeePaise; collaborators get 0 for those fields.
        for (const split of splits) {
          const isOwner = split.role === "OWNER";
          const splitBase = calculateEarningsData(payment, split.consultantProfileId);
          const shareBps = totalConsultantPool > 0
            ? Math.round((split.share / totalConsultantPool) * 10000)
            : 0;

          earningsToCreate.push({
            ...splitBase,
            consultantSharePaise: split.share,
            grossAmount: isOwner ? baseEarnings.grossAmount : 0,
            platformFeePaise: isOwner ? baseEarnings.platformFeePaise : 0,
            role: isOwner ? EarningRole.OWNER : EarningRole.COLLABORATOR,
            shareBps,
          });

          const currentRevenue = revenueUpdates.get(split.consultantProfileId) || 0;
          revenueUpdates.set(
            split.consultantProfileId,
            currentRevenue + split.share,
          );
        }
      } else {
        // Single-party earnings (owner only, or no collaborators)
        earningsToCreate.push({
          ...baseEarnings,
          role: EarningRole.OWNER,
          shareBps: 10000,
        });

        const currentRevenue = revenueUpdates.get(consultantProfileId) || 0;
        revenueUpdates.set(
          consultantProfileId,
          currentRevenue + baseEarnings.consultantSharePaise,
        );
      }
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
