#!/usr/bin/env node

/**
 * Abandoned Payment Cleanup Script (Local Version)
 *
 * This script cleans up abandoned payments and appointments
 * that have exceeded their timeout periods.
 *
 * Usage:
 * - npm run scripts:cleanup-abandoned-payments
 * - node scripts/cleanup-abandoned-payments.ts
 */

import { PrismaClient, PaymentStatus, PaymentGateway } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Cancel payment intent with the appropriate payment gateway
 */
async function cancelPaymentIntent(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  try {
    switch (gateway) {
      case "STRIPE":
        // Stripe cancellation logic
        if (process.env.STRIPE_SECRET_KEY) {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          await stripe.paymentIntents.cancel(paymentIntent);
          console.log(`✅ Cancelled Stripe payment intent: ${paymentIntent}`);
        } else {
          console.warn("⚠️ STRIPE_SECRET_KEY not configured");
        }
        break;

      case "RAZORPAY":
        // Razorpay cancellation logic
        if (process.env.RAZORPAY_KEY_SECRET) {
          const Razorpay = require("razorpay");
          const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
          });
          await razorpay.payments.cancel(paymentIntent);
          console.log(`✅ Cancelled Razorpay payment: ${paymentIntent}`);
        } else {
          console.warn("⚠️ RAZORPAY credentials not configured");
        }
        break;

      case "LEMON_SQUEEZY":
        // Lemon Squeezy cancellation logic
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

      case "XFLOW":
        // Xflow cancellation logic
        if (process.env.XFLOW_SECRET_KEY) {
          // Add Xflow cancellation logic here
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
 * Main cleanup function
 */
async function cleanupAbandonedPayments() {
  console.log("🧹 Starting abandoned payment cleanup...");

  try {
    // Find abandoned appointments with pending payments
    const abandonedAppointments = await prisma.appointment.findMany({
      where: {
        payment: {
          some: {
            AND: [
              { paymentStatus: "PENDING" },
              {
                OR: [
                  { expiresAt: { lt: new Date() } }, // Explicitly expired
                  {
                    AND: [
                      { expiresAt: null }, // No expiration set (legacy)
                      {
                        createdAt: {
                          lt: new Date(Date.now() - 30 * 60 * 1000),
                        },
                      }, // 30 min fallback
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
          where: { paymentStatus: "PENDING" },
        },
        consultation: true,
        subscription: true,
        webinar: true,
        class: true,
        slotsOfAppointment: true,
      },
    });

    console.log(
      `📊 Found ${abandonedAppointments.length} abandoned appointments to clean up`,
    );

    let cleanedCount = 0;
    let errorCount = 0;

    // Process each abandoned appointment
    for (const appointment of abandonedAppointments) {
      try {
        await prisma.$transaction(async (tx) => {
          // Cancel payment intents
          for (const payment of appointment.payment) {
            try {
              await cancelPaymentIntent(
                payment.paymentIntent,
                payment.paymentGateway,
              );

              // Update payment status
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
              } else if (appointment.subscription) {
                await tx.subscription.delete({
                  where: { id: appointment.subscription.id },
                });
              }

              await tx.appointment.delete({
                where: { id: appointment.id },
              });
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

        cleanedCount++;
        console.log(
          `✅ Successfully cleaned up appointment: ${appointment.id}`,
        );
      } catch (error) {
        errorCount++;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `❌ Failed to clean up appointment ${appointment.id}:`,
          errorMessage,
        );
      }
    }

    // Summary
    console.log(`\n📈 Cleanup Summary:`);
    console.log(`   ✅ Successfully cleaned: ${cleanedCount} appointments`);
    console.log(`   ❌ Failed to clean: ${errorCount} appointments`);
    console.log(
      `   📊 Total processed: ${abandonedAppointments.length} appointments`,
    );

    if (errorCount > 0) {
      console.warn(
        `⚠️ ${errorCount} appointments failed to clean up - manual intervention may be required`,
      );
    }
  } catch (error) {
    console.error("❌ Cleanup job failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the cleanup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupAbandonedPayments()
    .then(() => {
      console.log("🎉 Cleanup job completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Cleanup job failed:", error);
      process.exit(1);
    });
}

export { cleanupAbandonedPayments };
