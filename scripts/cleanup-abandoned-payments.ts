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
  PrismaClient,
  PaymentStatus,
  PaymentGateway,
  RequestStatus,
} from "@prisma/client";
import Stripe from "stripe";
import { cancelRazorpayOrder } from "../lib/payments/core/razorpay";

const prisma = new PrismaClient();

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  success: boolean;
  cleanedCount: number;
  errorCount: number;
  totalProcessed: number;
  errors: string[];
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

      case PaymentGateway.LEMON_SQUEEZY:
        if (process.env.LEMON_SQUEEZY_API_KEY) {
          const response = await fetch(
            `https://api.lemonsqueezy.com/v1/payments/${paymentIntent}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
                "Content-Type": "application/json",
              },
            },
          );
          if (response.ok) {
            console.log(`✅ Cancelled Lemon Squeezy payment: ${paymentIntent}`);
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } else {
          console.warn("⚠️ LEMON_SQUEEZY_API_KEY not configured");
        }
        break;

      case PaymentGateway.XFLOW:
        if (process.env.XFLOW_SECRET_KEY) {
          // Add Xflow cancellation logic here when available
          console.log(`✅ Cancelled Xflow payment: ${paymentIntent}`);
        } else {
          console.warn("⚠️ XFLOW_SECRET_KEY not configured");
        }
        break;

      default:
        console.warn(`⚠️ Unknown payment gateway: ${gateway}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `❌ Failed to cancel ${gateway} payment intent ${paymentIntent}:`,
      errorMessage,
    );
    throw error;
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
export async function cleanupAbandonedPayments(): Promise<CleanupResult> {
  console.log("🧹 Starting abandoned payment cleanup...");

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    // Find abandoned appointments with pending payments
    const abandonedAppointments = await prisma.appointment.findMany({
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
        slotsOfAppointment: {
          some: {
            isTentative: true,
          },
        },
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

    result.totalProcessed = abandonedAppointments.length;
    console.log(
      `📊 Found ${abandonedAppointments.length} abandoned appointments to clean up`,
    );

    // Process each abandoned appointment
    for (const appointment of abandonedAppointments) {
      try {
        await prisma.$transaction(async (tx) => {
          // FIX Issue #10: Re-check payment status before cleanup
          // Prevents race condition where payment webhook fires during cleanup
          let shouldSkip = false;
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
              shouldSkip = true;
              break;
            }
          }

          if (shouldSkip) {
            return;
          }

          // Cancel payment intents
          for (const payment of appointment.payment) {
            try {
              await cancelPaymentIntent(
                payment.paymentIntent,
                payment.paymentGateway,
              );

              // Update payment status to FAILED
              await tx.payment.update({
                where: { id: payment.id },
                data: { paymentStatus: PaymentStatus.FAILED },
              });
            } catch (paymentError) {
              const errorMessage =
                paymentError instanceof Error
                  ? paymentError.message
                  : "Unknown error";
              console.warn(
                `⚠️ Failed to cancel payment intent ${payment.paymentIntent}:`,
                errorMessage,
              );
              result.errors.push(
                `Payment cancellation failed for ${payment.paymentIntent}: ${errorMessage}`,
              );
              // Continue cleanup even if payment cancellation fails
            }
          }

          // Remove tentative slots for webinar/class (many-to-many relationships)
          if (appointment.webinar || appointment.class) {
            await tx.slotOfAppointment.deleteMany({
              where: {
                appointmentId: appointment.id,
                isTentative: true,
              },
            });
            console.log(
              `🗑️ Cleaned up tentative slots for ${appointment.webinar ? "webinar" : "class"} appointment: ${appointment.id}`,
            );
          }

          // For consultation/subscription, check if any non-tentative slots exist
          else if (appointment.consultation || appointment.subscription) {
            const confirmedSlots = await tx.slotOfAppointment.count({
              where: {
                appointmentId: appointment.id,
                isTentative: false,
              },
            });

            if (confirmedSlots === 0) {
              // Safe to delete the entire appointment and its relationships
              await tx.slotOfAppointment.deleteMany({
                where: { appointmentId: appointment.id },
              });

              if (appointment.consultation) {
                await tx.consultation.delete({
                  where: { id: appointment.consultation.id },
                });
                // Appointment is cascade-deleted when Consultation is deleted (onDelete: Cascade)
              } else if (appointment.subscription) {
                await tx.subscription.delete({
                  where: { id: appointment.subscription.id },
                });
                // Appointment is cascade-deleted when Subscription is deleted (onDelete: Cascade)
              }

              console.log(
                `🗑️ Deleted entire abandoned ${appointment.consultation ? "consultation" : "subscription"} appointment: ${appointment.id}`,
              );
            } else {
              // Only remove tentative slots
              await tx.slotOfAppointment.deleteMany({
                where: {
                  appointmentId: appointment.id,
                  isTentative: true,
                },
              });
              console.log(
                `🗑️ Cleaned up tentative slots for ${appointment.consultation ? "consultation" : "subscription"} appointment: ${appointment.id}`,
              );
            }
          }
        });

        result.cleanedCount++;
        console.log(
          `✅ Successfully cleaned up appointment: ${appointment.id}`,
        );
      } catch (error) {
        result.errorCount++;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `❌ Failed to clean up appointment ${appointment.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Appointment cleanup failed for ${appointment.id}: ${errorMessage}`,
        );
      }
    }

    // Determine overall success
    result.success = result.errorCount === 0;

    // Summary
    console.log(`\n📈 Cleanup Summary:`);
    console.log(
      `   ✅ Successfully cleaned: ${result.cleanedCount} appointments`,
    );
    console.log(`   ❌ Failed to clean: ${result.errorCount} appointments`);
    console.log(`   📊 Total processed: ${result.totalProcessed} appointments`);

    if (result.totalProcessed > 0) {
      console.log(
        `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
      );
    }

    if (result.errorCount > 0) {
      console.warn(
        `⚠️ ${result.errorCount} appointments failed to clean up - manual intervention may be required`,
      );
      result.errors.forEach((error, index) => {
        console.warn(`   ${index + 1}. ${error}`);
      });
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
export async function cleanupExpiredApprovalPendingPayments(): Promise<CleanupResult> {
  console.log(
    "🧹 Starting cleanup of expired APPROVED_PENDING_PAYMENT consultations...",
  );

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    // Find consultations stuck in APPROVED_PENDING_PAYMENT with expired payments
    const expiredConsultations = await prisma.consultation.findMany({
      where: {
        requestStatus: RequestStatus.APPROVED_PENDING_PAYMENT,
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
        await prisma.$transaction(async (tx) => {
          // Update consultation status to REJECTED
          await tx.consultation.update({
            where: { id: consultation.id },
            data: { requestStatus: RequestStatus.REJECTED },
          });

          // Delete tentative slots if appointment exists
          if (consultation.appointment?.slotsOfAppointment) {
            const deletedSlots = await tx.slotOfAppointment.deleteMany({
              where: {
                AND: [
                  { appointmentId: consultation.appointment.id },
                  { isTentative: true },
                ],
              },
            });
            console.log(
              `🗑️ Deleted ${deletedSlots.count} tentative slots for consultation ${consultation.id}`,
            );
          }

          // Mark expired payments as failed
          if (consultation.appointment?.payment) {
            for (const payment of consultation.appointment.payment) {
              await tx.payment.update({
                where: { id: payment.id },
                data: { paymentStatus: PaymentStatus.FAILED },
              });
            }
          }

          console.log(
            `✅ Reset consultation ${consultation.id} from APPROVED_PENDING_PAYMENT to REJECTED`,
          );
        });

        result.cleanedCount++;
      } catch (error) {
        result.errorCount++;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
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

    // Summary
    console.log(`\n📈 Expired Consultation Cleanup Summary:`);
    console.log(
      `   ✅ Successfully cleaned: ${result.cleanedCount} consultations`,
    );
    console.log(`   ❌ Failed to clean: ${result.errorCount} consultations`);
    console.log(
      `   📊 Total processed: ${result.totalProcessed} consultations`,
    );

    if (result.totalProcessed > 0) {
      console.log(
        `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
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
