/**
 * Stale PENDING Request Expiration - Core Logic
 *
 * Auto-expires consultations and subscriptions stuck in PENDING state for too long.
 * This happens when:
 * - Consultant never responded to a request
 * - Consultee abandoned the request
 * - System error prevented status update
 *
 * This module exports the core expiration function.
 * It is imported by:
 * - jobs/expire-stale-requests.ts (GitHub Actions)
 * - app/api/cleanup/expire-stale-requests/route.ts (API endpoint)
 *
 * Schedule: Hourly (booking-journey audit B1 — a PENDING consultation holds
 * a tentative slot, so the old daily cadence plus a 30-day threshold let a
 * single account pin a consultant's calendar for a month).
 */

import prisma from "../../lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// The per-cohort WHERE guards below (PENDING by requestedAt,
// APPROVED_PENDING_PAYMENT by updatedAt) are deliberate subsets of
// REQUEST_ALLOWED_FROM.EXPIRED in lib/booking/transitions.ts (#836) —
// each cohort has its own cutoff, so they are not merged into one sweep.

// Expire PENDING consultations after 48 hours. A PENDING consultation is not
// just paperwork — its request-for-approval tentative slots block the
// consultant's calendar, so the threshold is measured in hours, not days.
// Subscriptions hold no slots at request time (lazy allocation), so they
// keep the generous window below.
const PENDING_CONSULTATION_EXPIRATION_HOURS = 48;

// Expire requests in PENDING state for more than 30 days (subscriptions).
const PENDING_EXPIRATION_DAYS = 30;

// Also expire APPROVED_PENDING_PAYMENT after 7 days
const PAYMENT_PENDING_EXPIRATION_DAYS = 7;

export interface ExpireStaleRequestsResult {
  success: boolean;
  consultationsExpired: number;
  subscriptionsExpired: number;
  paymentPendingExpired: number;
  /** Tentative slots freed by the consultation expiry (B1). */
  consultationSlotsReleased: number;
  errors: string[];
  timestamp: string;
}

/**
 * Expire stale PENDING consultations and release the tentative slots they
 * pinned. The slot release happens HERE rather than waiting for the
 * tentative-slot sweeper: that sweep's parent guard skips PENDING
 * consultations by design (a consultant may legitimately be reviewing), so
 * before B1 a slot pinned by a stale request waited for the status flip and
 * then another sweeper cycle — 30+ days in the worst case.
 */
async function expirePendingConsultations(): Promise<{
  expired: number;
  slotsReleased: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_CONSULTATION_EXPIRATION_HOURS * 60 * 60 * 1000,
  );

  try {
    // Find stale PENDING consultations (with their appointment ids so the
    // slot release below can target exactly the expired rows).
    const staleConsultations = await prisma.consultation.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
      },
      select: { id: true, appointment: { select: { id: true } } },
    });

    console.log(
      `Found ${staleConsultations.length} consultations in PENDING for >${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    );

    if (staleConsultations.length === 0) {
      return { expired: 0, slotsReleased: 0, errors };
    }

    const expiredIds = staleConsultations.map((c) => c.id);
    const expiredAppointmentIds = staleConsultations
      .map((c) => c.appointment?.id)
      .filter((id): id is string => !!id);

    // Bulk update to EXPIRED
    const result = await prisma.consultation.updateMany({
      where: {
        id: { in: expiredIds },
        status: AppointmentStatus.PENDING,
      },
      data: {
        status: AppointmentStatus.EXPIRED,
      },
    });

    // Release the tentative holds the expired requests pinned. Scoped to
    // isTentative so an already-confirmed slot (impossible for a PENDING
    // request, but cheap to assert) is never touched.
    let slotsReleased = 0;
    if (expiredAppointmentIds.length > 0) {
      const slotResult = await prisma.slotOfAppointment.deleteMany({
        where: {
          appointmentId: { in: expiredAppointmentIds },
          isTentative: true,
        },
      });
      slotsReleased = slotResult.count;
    }

    console.log(`✅ Expired ${result.count} PENDING consultations`);
    console.log(`✅ Released ${slotsReleased} tentative slots from them`);
    return { expired: result.count, slotsReleased, errors };
  } catch (error) {
    const msg = `Failed to expire consultations: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, slotsReleased: 0, errors };
  }
}

/**
 * Expire stale PENDING subscriptions
 */
async function expirePendingSubscriptions(): Promise<{
  expired: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    // Find stale PENDING subscriptions
    const staleSubscriptions = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
      },
      include: {
        requestedBy: {
          include: { user: { select: { email: true, name: true } } },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: { user: { select: { email: true, name: true } } },
            },
          },
        },
      },
    });

    console.log(
      `Found ${staleSubscriptions.length} subscriptions in PENDING for >${PENDING_EXPIRATION_DAYS} days`,
    );

    for (const subscription of staleSubscriptions) {
      console.log(`\nExpiring subscription ${subscription.id}`);
      console.log(
        `   Requested by: ${subscription.requestedBy.user.name || "Unknown"}`,
      );
      console.log(
        `   Consultant: ${subscription.subscriptionPlan.consultantProfile.user.name || "Unknown"}`,
      );
      console.log(`   Requested at: ${subscription.requestedAt.toISOString()}`);
    }

    // Bulk update to EXPIRED
    const result = await prisma.subscription.updateMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
      },
      data: {
        status: AppointmentStatus.EXPIRED,
      },
    });

    console.log(`✅ Expired ${result.count} PENDING subscriptions`);
    return { expired: result.count, errors };
  } catch (error) {
    const msg = `Failed to expire subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, errors };
  }
}

/**
 * Expire requests stuck in APPROVED_PENDING_PAYMENT
 */
async function expirePaymentPendingRequests(): Promise<{
  consultationsExpired: number;
  subscriptionsExpired: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PAYMENT_PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    // Expire consultations awaiting payment
    const consultationResult = await prisma.consultation.updateMany({
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
      },
      data: {
        status: AppointmentStatus.EXPIRED,
        pendingPaymentUrl: null, // Clear payment link
      },
    });

    console.log(
      `✅ Expired ${consultationResult.count} consultations awaiting payment`,
    );

    // Expire subscriptions awaiting payment
    const subscriptionResult = await prisma.subscription.updateMany({
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
      },
      data: {
        status: AppointmentStatus.EXPIRED,
        pendingPaymentUrl: null, // Clear payment link
      },
    });

    console.log(
      `✅ Expired ${subscriptionResult.count} subscriptions awaiting payment`,
    );

    return {
      consultationsExpired: consultationResult.count,
      subscriptionsExpired: subscriptionResult.count,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire payment pending requests: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { consultationsExpired: 0, subscriptionsExpired: 0, errors };
  }
}

/**
 * Main function to expire all stale requests
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function expireStaleRequests(): Promise<ExpireStaleRequestsResult> {
  return withCronLock("expire-stale-requests", { failMode: "open" }, () =>
    expireStaleRequestsUnlocked(),
  );
}

async function expireStaleRequestsUnlocked(): Promise<ExpireStaleRequestsResult> {
  const allErrors: string[] = [];

  console.log("🕐 Starting stale request expiration...");
  console.log(
    `   Consultation PENDING expiration threshold: ${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    `   Subscription PENDING expiration threshold: ${PENDING_EXPIRATION_DAYS} days`,
  );
  console.log(
    `   APPROVED_PENDING_PAYMENT expiration: ${PAYMENT_PENDING_EXPIRATION_DAYS} days`,
  );

  // Expire PENDING consultations
  const consultationResult = await expirePendingConsultations();
  allErrors.push(...consultationResult.errors);

  // Expire PENDING subscriptions
  const subscriptionResult = await expirePendingSubscriptions();
  allErrors.push(...subscriptionResult.errors);

  // Expire APPROVED_PENDING_PAYMENT requests
  const paymentPendingResult = await expirePaymentPendingRequests();
  allErrors.push(...paymentPendingResult.errors);

  const totalPaymentPending =
    paymentPendingResult.consultationsExpired +
    paymentPendingResult.subscriptionsExpired;

  // Summary
  console.log("\n📊 Stale Request Expiration Summary:");
  console.log(
    `   Consultations expired (PENDING >${PENDING_CONSULTATION_EXPIRATION_HOURS}h): ${consultationResult.expired}`,
  );
  console.log(
    `   Tentative slots released with them: ${consultationResult.slotsReleased}`,
  );
  console.log(
    `   Subscriptions expired (PENDING): ${subscriptionResult.expired}`,
  );
  console.log(`   Payment pending expired: ${totalPaymentPending}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    consultationsExpired: consultationResult.expired,
    subscriptionsExpired: subscriptionResult.expired,
    paymentPendingExpired: totalPaymentPending,
    consultationSlotsReleased: consultationResult.slotsReleased,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
