#!/usr/bin/env node

/**
 * Abandoned Payment Cleanup Script
 *
 * Core library for cleaning up abandoned payments and appointments
 * that have exceeded their timeout periods.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:cleanup-abandoned-payments`
 * - GitHub Actions: `jobs/cleanup-abandoned-payments.ts`
 * - API routes: Can import and call functions directly
 *
 * Contains race condition fixes:
 * - Issue #6: 35 min buffer (5 min over 30 min expiry) for legacy payments
 * - Issue #10: Re-check payment status before cleanup to handle webhooks
 */

import {
  PaymentStatus,
  PaymentGateway,
  AppointmentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import Stripe from "stripe";
import { cancelRazorpayOrder } from "../../lib/payments/core/razorpay";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import {
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import prisma, { type Tx } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  success: boolean;
  cleanedCount: number;
  /** Rows whose status moved since the cohort read; left alone, not failures. */
  skippedCount: number;
  errorCount: number;
  totalProcessed: number;
  errors: string[];
}

export interface CleanupAbandonedOptions {
  /** #1356 — caps the cohort for the Netlify ticker; undefined keeps the
   * unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * Cancel payment intent with the appropriate payment gateway
 */
export async function cancelPaymentIntent(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  try {
    switch (gateway) {
      case PaymentGateway.STRIPE:
        if (process.env.STRIPE_SECRET_KEY) {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          await stripe.paymentIntents.cancel(paymentIntent);
          console.log(`✅ Cancelled Stripe payment intent: ${paymentIntent}`);
        } else {
          console.warn("⚠️ STRIPE_SECRET_KEY not configured");
        }
        break;

      case PaymentGateway.RAZORPAY:
        await cancelRazorpayOrder(paymentIntent);
        break;

      default:
        console.warn(`⚠️ Unknown payment gateway: ${gateway}`);
    }
  } catch (error) {
    console.error(
      `❌ Failed to cancel ${gateway} payment intent ${paymentIntent}:`,
      describeError(error),
    );
    throw error;
  }
}

/** Every catch in this sweep reports a failure the same way. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Both sweeps below report the same shape, so one printer keeps them in step. */
function logCleanupSummary(
  title: string,
  noun: string,
  result: CleanupResult,
): void {
  console.log(`\n📈 ${title}:`);
  console.log(`   ✅ Successfully cleaned: ${result.cleanedCount} ${noun}`);
  console.log(
    `   ⏭️ Skipped (status moved since the read): ${result.skippedCount} ${noun}`,
  );
  console.log(`   ❌ Failed to clean: ${result.errorCount} ${noun}`);
  console.log(`   📊 Total processed: ${result.totalProcessed} ${noun}`);

  if (result.totalProcessed > 0) {
    console.log(
      `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
    );
  }

  if (result.errorCount > 0) {
    console.warn(
      `⚠️ ${result.errorCount} ${noun} failed to clean up - manual intervention may be required`,
    );
    result.errors.forEach((error, index) => {
      console.warn(`   ${index + 1}. ${error}`);
    });
  }
}

/**
 * The cohort: an appointment still holding a slot or a group seat against a
 * PENDING payment that has passed its expiry.
 */
function findAbandonedAppointments(limit?: number) {
  return prisma.appointment.findMany({
    take: limit,
    // Oldest-first with an id tie-break: a bounded run must not leave the
    // same stale holds behind every tick while newer ones get processed.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    where: {
      payment: {
        some: {
          AND: [
            { paymentStatus: PaymentStatus.PENDING },
            {
              OR: [
                { expiresAt: { lt: new Date() } }, // Explicitly expired
                {
                  AND: [
                    { expiresAt: null }, // No expiration set (legacy)
                    {
                      createdAt: {
                        // FIX Issue #6: 35 min buffer (5 min over 30 min expiry)
                        // Prevents race condition at payment expiration boundary
                        lt: new Date(Date.now() - 35 * 60 * 1000),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      // Group-event seats are held by connecting the buyer to shared,
      // non-tentative slots, so a tentative-slot filter would never see an
      // abandoned webinar or class checkout.
      OR: [
        { slotsOfAppointment: { some: { isTentative: true } } },
        { webinar: { isNot: null } },
        { class: { isNot: null } },
      ],
    },
    include: {
      payment: {
        where: { paymentStatus: PaymentStatus.PENDING },
      },
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
      slotsOfAppointment: true,
    },
  });
}

type AbandonedAppointment = Awaited<
  ReturnType<typeof findAbandonedAppointments>
>[number];
type AbandonedPayment = AbandonedAppointment["payment"][number];

/**
 * FIX Issue #10 — a capture webhook can land between the cohort read and this
 * transaction, so the payment status is re-read inside it before anything is
 * touched.
 */
async function anyPaymentSucceeded(
  tx: Pick<Tx, "payment">,
  appointment: AbandonedAppointment,
): Promise<boolean> {
  for (const payment of appointment.payment) {
    const freshPayment = await tx.payment.findUnique({
      where: { id: payment.id },
    });

    if (freshPayment?.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(
        JSON.stringify({
          event: "cleanup_skipped_payment_succeeded",
          paymentId: payment.id,
          appointmentId: appointment.id,
          reason: "Payment completed during cleanup processing",
          timestamp: new Date().toISOString(),
        }),
      );
      return true;
    }
  }
  return false;
}

/**
 * Cancel the gateway intent and mark the row EXPIRED (timed out, not a gateway
 * rejection). A gateway failure is recorded and the cleanup continues: the hold
 * still has to be released.
 */
async function expirePendingPayments(
  tx: Pick<Tx, "payment">,
  payments: AbandonedPayment[],
  errors: string[],
): Promise<void> {
  // #1459 — the gateway round trips run first and in parallel; the status
  // writes below stay one-at-a-time and in cohort order, because they are the
  // part that has to be a deterministic sequence inside the caller's
  // transaction. A payment whose cancel failed is reported and skipped, which
  // is what the sequential version did.
  const failures = await cancelGatewayIntents(payments);

  for (const payment of payments) {
    const failure = failures.get(payment.id);
    if (failure !== undefined) {
      console.warn(
        `⚠️ Failed to cancel payment intent ${payment.paymentIntent}:`,
        failure,
      );
      errors.push(
        `Payment cancellation failed for ${payment.paymentIntent}: ${failure}`,
      );
      continue;
    }

    // Conditional on PENDING: a capture racing this sweep keeps SUCCEEDED.
    await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.EXPIRED },
    });
  }
}

/**
 * #1459 — how many gateway cancels are in flight at once. The Netlify ticker
 * gives this sweep a 6 s budget (ADR 27) and one sequential round trip per
 * payment spent all of it on five stuck rows, so every tick aborted mid-sweep.
 * Five is enough to hide the latency without opening a burst the gateway would
 * rate-limit.
 */
const GATEWAY_CANCEL_CONCURRENCY = 5;

/**
 * #1459 — ceiling on a single cancel. Neither gateway client sets one, so a
 * hung connection would hold the whole batch past the ticker's timeout and the
 * payment would never be marked EXPIRED. A timed-out cancel is recorded like
 * any other gateway failure and retried on the next run.
 */
const GATEWAY_CANCEL_TIMEOUT_MS = 4_000;

async function cancelWithTimeout(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  // AbortSignal.timeout's timer does not hold the event loop open, so a cancel
  // that wins the race leaves nothing behind to keep the function alive.
  const signal = AbortSignal.timeout(GATEWAY_CANCEL_TIMEOUT_MS);
  await Promise.race([
    cancelPaymentIntent(paymentIntent, gateway),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(
          new Error(
            `Gateway cancel timed out after ${GATEWAY_CANCEL_TIMEOUT_MS} ms`,
          ),
        ),
      );
    }),
  ]);
}

/**
 * Cancel every payment's gateway intent with bounded concurrency.
 *
 * Exported for the concurrency pin: the ceiling is the whole point of the
 * function, and it is invisible from the outside of the sweep.
 *
 * @returns The failures only, keyed by payment id — a payment absent from the
 *   map was cancelled and is safe to mark EXPIRED.
 */
export async function cancelGatewayIntents(
  payments: readonly Pick<
    AbandonedPayment,
    "id" | "paymentIntent" | "paymentGateway"
  >[],
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();

  for (let i = 0; i < payments.length; i += GATEWAY_CANCEL_CONCURRENCY) {
    const chunk = payments.slice(i, i + GATEWAY_CANCEL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((payment) =>
        cancelWithTimeout(payment.paymentIntent, payment.paymentGateway),
      ),
    );
    settled.forEach((outcome, j) => {
      if (outcome.status === "rejected") {
        failures.set(chunk[j].id, describeError(outcome.reason));
      }
    });
  }

  return failures;
}

/**
 * Restore referral credits consumed by these payments. The rows now survive
 * (soft-cancel below), so this is the whole point rather than an ordering trick
 * against a cascade.
 */
async function restoreReferralCredits(
  tx: Tx,
  payments: AbandonedPayment[],
): Promise<void> {
  for (const payment of payments) {
    try {
      const restored = await reverseCreditsForPayment(payment.id, tx);
      if (restored > 0) {
        console.log(
          `🔄 Restored ${restored} paise of referral credits from abandoned payment ${payment.id}`,
        );
      }
    } catch (creditError) {
      console.warn(
        `⚠️ Failed to restore credits for payment ${payment.id}:`,
        describeError(creditError),
      );
    }
  }
}

/**
 * Group events: disconnect only the abandoning buyers. The session slots are
 * shared by everyone who registered, so deleting them would strand every other
 * attendee.
 */
async function releaseGroupSeats(
  tx: Pick<Tx, "slotOfAppointment">,
  appointment: AbandonedAppointment,
): Promise<void> {
  const kind = appointment.webinar ? "webinar" : "class";
  const abandonedUserIds = Array.from(
    new Set(appointment.payment.map((p) => p.userId)),
  );
  const seatFilter = appointment.class
    ? { appointment: { classId: appointment.class.id } }
    : { appointmentId: appointment.id };

  for (const abandonedUserId of abandonedUserIds) {
    const seatSlots = await tx.slotOfAppointment.findMany({
      where: {
        ...seatFilter,
        user: { some: { id: abandonedUserId } },
      },
      select: { id: true },
    });
    for (const slot of seatSlots) {
      await tx.slotOfAppointment.update({
        where: { id: slot.id },
        data: { user: { disconnect: { id: abandonedUserId } } },
      });
    }
    console.log(
      `🗑️ Released ${seatSlots.length} seat slot(s) for user ${abandonedUserId} on ${kind} appointment ${appointment.id}`,
    );
  }
}

/**
 * Consultation / subscription: with no confirmed slot left, the request is
 * EXPIRED through the CAS and everything under it is tombstoned; with one, only
 * the tentative holds are released and the confirmed history stays.
 *
 * #1074 / #1319 — never delete an Appointment a Payment row points at. Deleting
 * the request cascaded the Appointment and with it every Payment (EXPIRED
 * intents, credit usage, a late capture's target). The slot is freed by status,
 * not absence.
 *
 * A CAS miss throws out of the caller's transaction on purpose: the payment
 * expiry and the credit restoration that ran ahead of it must roll back with it.
 */
async function expireRequestAndReleaseSlots(
  tx: Pick<
    Tx,
    | "slotOfAppointment"
    | "appointment"
    | "consultation"
    | "subscription"
    | "bookingStatusHistory"
  >,
  appointment: AbandonedAppointment,
): Promise<void> {
  const kind = appointment.consultation ? "consultation" : "subscription";
  const confirmedSlots = await tx.slotOfAppointment.count({
    where: {
      appointmentId: appointment.id,
      isTentative: false,
    },
  });
  const now = new Date();

  if (confirmedSlots > 0) {
    // Only release the tentative slots; confirmed history stays.
    const released = await transitionSlotCompletion(tx, {
      where: {
        appointmentId: appointment.id,
        isTentative: true,
        deletedAt: null,
      },
      to: SlotCompletionStatus.CANCELLED,
      data: { deletedAt: now },
      allowZero: true,
    });
    console.log(
      `🗑️ Released ${released} tentative slot(s) for ${kind} appointment: ${appointment.id}`,
    );
    return;
  }

  // The cohort's money predicate is repeated in the CAS WHERE, like the
  // approval and stale-pending arms. Status alone is not enough: the include
  // above only carries PENDING rows, and `reconcile-payment-status` flips a
  // recovered capture to SUCCEEDED without moving the request — so a sibling
  // or freshly-succeeded payment is invisible to a read-then-write. Re-checked
  // by the UPDATE itself, a paid booking matches zero rows and is skipped.
  if (appointment.consultation) {
    await transitionConsultationRequest(tx, {
      where: {
        id: appointment.consultation.id,
        appointment: {
          payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  } else if (appointment.subscription) {
    // Subscription→Appointment is to-many (one per session), so the predicate
    // is "no appointment under this subscription carries a succeeded payment".
    await transitionSubscriptionRequest(tx, {
      where: {
        id: appointment.subscription.id,
        appointments: {
          none: {
            payment: { some: { paymentStatus: PaymentStatus.SUCCEEDED } },
          },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  }

  await transitionSlotCompletion(tx, {
    where: { appointmentId: appointment.id, deletedAt: null },
    to: SlotCompletionStatus.CANCELLED,
    data: { deletedAt: now },
    allowZero: true,
  });
  await tx.appointment.updateMany({
    where: { id: appointment.id, deletedAt: null },
    data: { deletedAt: now },
  });

  console.log(
    `🗑️ Expired abandoned ${kind} appointment (soft): ${appointment.id}`,
  );
}

/**
 * One appointment, one transaction: skip a capture that landed mid-sweep,
 * expire its payments, hand back the referral credits, then release the hold —
 * group seats for an event, request slots for a consultation or subscription.
 *
 * The CAS miss is caught OUTSIDE the transaction (the stale-pending sweep's
 * shape). Swallowing it inside would resolve the callback and commit the
 * payment expiry and credit restoration that ran before it, handing credits
 * back on a booking whose capture landed mid-transaction. Letting it escape
 * makes Prisma roll the whole unit back; only then is it counted as skipped.
 */
async function cleanupAbandonedAppointment(
  appointment: AbandonedAppointment,
  errors: string[],
): Promise<"cleaned" | "skipped"> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (await anyPaymentSucceeded(tx, appointment)) return "skipped" as const;

      await expirePendingPayments(tx, appointment.payment, errors);
      await restoreReferralCredits(tx, appointment.payment);

      if (appointment.webinar || appointment.class) {
        await releaseGroupSeats(tx, appointment);
        return "cleaned" as const;
      }
      if (appointment.consultation || appointment.subscription) {
        await expireRequestAndReleaseSlots(tx, appointment);
      }
      return "cleaned" as const;
    });
  } catch (error) {
    // Raced a capture or an approval: the row moved out of the expirable set,
    // or its payment succeeded, since the cohort read. The transaction is
    // rolled back by the time this runs — nothing above it was committed.
    if (!(error instanceof IllegalTransitionError)) throw error;
    console.log(
      `⏭️ Skipped appointment ${appointment.id} — status changed, or the payment succeeded, since the sweep read`,
    );
    return "skipped";
  }
}

/**
 * Clean up abandoned payments and appointments
 *
 * Finds appointments with:
 * - Pending payments that have expired (or legacy payments older than 35 min)
 * - Tentative slots that need to be released
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupAbandonedPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupAbandonedPaymentsUnlocked(opts),
  );
}

async function cleanupAbandonedPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log("🧹 Starting abandoned payment cleanup...");

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    const abandonedAppointments = await findAbandonedAppointments(opts.limit);

    result.totalProcessed = abandonedAppointments.length;
    console.log(
      `📊 Found ${abandonedAppointments.length} abandoned appointments to clean up`,
    );

    for (const appointment of abandonedAppointments) {
      try {
        const outcome = await cleanupAbandonedAppointment(
          appointment,
          result.errors,
        );

        if (outcome === "skipped") {
          result.skippedCount++;
        } else {
          result.cleanedCount++;
          console.log(
            `✅ Successfully cleaned up appointment: ${appointment.id}`,
          );
        }
      } catch (error) {
        result.errorCount++;
        const errorMessage = describeError(error);
        console.error(
          `❌ Failed to clean up appointment ${appointment.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Appointment cleanup failed for ${appointment.id}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errorCount === 0;
    logCleanupSummary("Cleanup Summary", "appointments", result);
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Cleanup job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Cleanup expired APPROVED_PENDING_PAYMENT consultations
 *
 * FIX for orphaned payment bug:
 * When a consultant approves a consultation and payment expires,
 * the consultation status remains APPROVED_PENDING_PAYMENT forever,
 * blocking the slot permanently. This function resets those consultations.
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupExpiredApprovalPendingPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupExpiredApprovalPendingPaymentsUnlocked(opts),
  );
}

async function cleanupExpiredApprovalPendingPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log(
    "🧹 Starting cleanup of expired APPROVED_PENDING_PAYMENT consultations...",
  );

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    // Find consultations stuck in APPROVED_PENDING_PAYMENT with expired payments
    const expiredConsultations = await prisma.consultation.findMany({
      take: opts.limit,
      // Oldest-first with an id tie-break: see findAbandonedAppointments above.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        appointment: {
          payment: {
            some: {
              AND: [
                { paymentStatus: PaymentStatus.PENDING },
                { expiresAt: { lt: new Date() } },
              ],
            },
          },
        },
      },
      include: {
        appointment: {
          include: {
            payment: {
              where: { paymentStatus: PaymentStatus.PENDING },
            },
            slotsOfAppointment: true,
          },
        },
      },
    });

    result.totalProcessed = expiredConsultations.length;
    console.log(
      `📊 Found ${expiredConsultations.length} expired APPROVED_PENDING_PAYMENT consultations`,
    );

    // Process each expired consultation
    for (const consultation of expiredConsultations) {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          // #1319 — the pay-link lapsed, so this is EXPIRED, not REJECTED:
          // REJECTED reads as "the consultant declined" on every surface, and
          // the CAS keeps a capture that raced this sweep from being clobbered.
          try {
            // The cohort read's payment filter is repeated in the UPDATE's
            // WHERE: a capture that landed since the read (Stripe reconcile
            // flips the payment without touching the request) makes this
            // match zero rows instead of expiring a paid booking.
            await transitionConsultationRequest(tx, {
              where: {
                id: consultation.id,
                appointment: {
                  payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
                },
              },
              to: AppointmentStatus.EXPIRED,
              fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
            });
          } catch (error) {
            if (!(error instanceof IllegalTransitionError)) throw error;
            console.log(
              `⏭️ Skipped consultation ${consultation.id} — status changed since the sweep read`,
            );
            return "skipped" as const;
          }

          // Release the tentative hold by status; the rows stay for support.
          if (consultation.appointment) {
            const released = await transitionSlotCompletion(tx, {
              where: {
                appointmentId: consultation.appointment.id,
                isTentative: true,
                deletedAt: null,
              },
              to: SlotCompletionStatus.CANCELLED,
              data: { deletedAt: new Date() },
              allowZero: true,
            });
            console.log(
              `🗑️ Released ${released} tentative slot(s) for consultation ${consultation.id}`,
            );
          }

          // Mark expired payments as EXPIRED (timed out, not a gateway rejection)
          if (consultation.appointment?.payment) {
            for (const payment of consultation.appointment.payment) {
              // Conditional: only a still-PENDING row expires; a capture that
              // raced this write keeps its SUCCEEDED status.
              await tx.payment.updateMany({
                where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
                data: { paymentStatus: PaymentStatus.EXPIRED },
              });
            }
          }

          console.log(
            `✅ Reset consultation ${consultation.id} from APPROVED_PENDING_PAYMENT to EXPIRED`,
          );
          return "cleaned" as const;
        });

        if (outcome === "skipped") {
          result.skippedCount++;
        } else {
          result.cleanedCount++;
        }
      } catch (error) {
        result.errorCount++;
        const errorMessage = describeError(error);
        console.error(
          `❌ Failed to clean up consultation ${consultation.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Consultation cleanup failed for ${consultation.id}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errorCount === 0;
    logCleanupSummary(
      "Expired Consultation Cleanup Summary",
      "consultations",
      result,
    );
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Expired consultation cleanup failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Run all cleanup tasks
 *
 * Executes both abandoned payment cleanup and expired consultation cleanup.
 * Disconnects from database when complete.
 *
 * @returns Combined results from both cleanup operations
 */
export async function runAllCleanupTasks(): Promise<{
  paymentResult: CleanupResult;
  consultationResult: CleanupResult;
  overallSuccess: boolean;
}> {
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    // Run abandoned payment cleanup
    const paymentResult = await cleanupAbandonedPayments();

    // Run expired consultation cleanup
    const consultationResult = await cleanupExpiredApprovalPendingPayments();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Combined summary
    console.log(`\n📊 Overall Cleanup Summary:`);
    console.log(
      `   🧹 Abandoned payments cleaned: ${paymentResult.cleanedCount}`,
    );
    console.log(
      `   🧹 Expired consultations reset: ${consultationResult.cleanedCount}`,
    );
    console.log(
      `   ❌ Total errors: ${paymentResult.errorCount + consultationResult.errorCount}`,
    );

    const overallSuccess = paymentResult.success && consultationResult.success;

    return {
      paymentResult,
      consultationResult,
      overallSuccess,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 * Call this when done using the cleanup functions if not using runAllCleanupTasks
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the cleanup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllCleanupTasks()
    .then(({ overallSuccess }) => {
      if (overallSuccess) {
        console.log("🎉 Cleanup job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Cleanup job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Cleanup job failed:", error);
      process.exit(1);
    });
}
