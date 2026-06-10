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
import { PaymentStatus, AppointmentsType } from "@prisma/client";
import { AppointmentType } from "../../lib/payments/payouts/constants";
import { createEarningsFromPayment } from "../../lib/payments/payouts/earnings-service";

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

    // #773 — delegate creation to createEarningsFromPayment, the single
    // source of truth: it resolves collaborator + HOST-org settlement, nets
    // shares, and posts the balanced booking:<paymentId> journal txn in the
    // same operation. The old local writer minted full-share collaborator
    // rows with NO journal — every synced multi-party payment was born as
    // EARNINGS_WITHOUT_BOOKING_TXN drift. Old payments get a fresh hold
    // window (the release cron flips them READY on schedule).
    for (const payment of payments) {
      if (existingPaymentIds.has(payment.id)) {
        skippedCount++;
        continue;
      }

      const appointment = payment.appointment;
      const consultantProfileId =
        appointment?.consultation?.consultationPlan?.consultantProfileId ||
        appointment?.subscription?.subscriptionPlan?.consultantProfileId ||
        appointment?.webinar?.webinarPlan?.consultantProfileId ||
        appointment?.class?.classPlan?.consultantProfileId;

      if (!appointment || !consultantProfileId) {
        console.log(
          `⏭️ Skipping payment ${payment.id} - no consultant profile found`,
        );
        skippedCount++;
        continue;
      }

      try {
        const earningsId = await createEarningsFromPayment({
          payment: {
            ...payment,
            appointment: {
              consultantProfile: { id: consultantProfileId },
              webinar: appointment.webinar
                ? { webinarPlanId: appointment.webinar.webinarPlanId }
                : null,
              class: appointment.class
                ? { classPlanId: appointment.class.classPlanId }
                : null,
            },
          },
          appointmentType: mapAppointmentType(appointment.appointmentType),
        });
        if (earningsId) {
          createdCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Payment ${payment.id}: ${msg}`);
        errorCount++;
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
