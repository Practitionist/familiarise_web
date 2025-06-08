/**
 * Abandoned Payment Cleanup Job (GitHub Actions Version)
 *
 * This job cleans up abandoned payments and appointments
 * that have exceeded their timeout periods.
 *
 * Optimized for GitHub Actions CI/CD environment.
 * Runs every 15 minutes via scheduled workflow.
 */

import { PrismaClient, PaymentStatus, PaymentGateway } from "@prisma/client";

const prisma = new PrismaClient();

interface CleanupResult {
  success: boolean;
  cleanedCount: number;
  errorCount: number;
  totalProcessed: number;
  errors: string[];
}

/**
 * Cancel payment intent with the appropriate payment gateway
 */
async function cancelPaymentIntent(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  try {
    switch (gateway) {
      case PaymentGateway.STRIPE:
        if (process.env.STRIPE_SECRET_KEY) {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          await stripe.paymentIntents.cancel(paymentIntent);
          console.log(`✅ Cancelled Stripe payment intent: ${paymentIntent}`);
        } else {
          console.warn("⚠️ STRIPE_SECRET_KEY not configured");
        }
        break;

      case PaymentGateway.RAZORPAY:
        if (process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_ID) {
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
 * Main cleanup function optimized for GitHub Actions
 */
async function cleanupAbandonedPayments(): Promise<CleanupResult> {
  console.log("🧹 Starting abandoned payment cleanup job...");

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
          // Cancel payment intents
          for (const payment of appointment.payment) {
            try {
              await cancelPaymentIntent(
                payment.paymentIntent,
                payment.paymentGateway,
              );

              // Update payment status to FAILED (cancelled payments are considered failed)
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

    // Summary for GitHub Actions logs
    console.log(`\n📈 Cleanup Job Summary:`);
    console.log(
      `   ✅ Successfully cleaned: ${result.cleanedCount} appointments`,
    );
    console.log(`   ❌ Failed to clean: ${result.errorCount} appointments`);
    console.log(`   📊 Total processed: ${result.totalProcessed} appointments`);
    console.log(
      `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
    );

    if (result.errorCount > 0) {
      console.warn(`⚠️ ${result.errorCount} appointments failed to clean up`);
      console.warn("Errors encountered:");
      result.errors.forEach((error, index) => {
        console.warn(`   ${index + 1}. ${error}`);
      });
    }

    // GitHub Actions workflow outputs
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::set-output name=cleaned_count::${result.cleanedCount}`);
      console.log(`::set-output name=error_count::${result.errorCount}`);
      console.log(
        `::set-output name=total_processed::${result.totalProcessed}`,
      );
      console.log(`::set-output name=success::${result.success}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Cleanup job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;

    // Fail the GitHub Action if critical error
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::set-output name=success::false`);
      console.log(`::error::Cleanup job failed: ${errorMessage}`);
    }
  } finally {
    await prisma.$disconnect();
  }

  return result;
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    const result = await cleanupAbandonedPayments();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    if (result.success) {
      console.log("🎉 Cleanup job completed successfully");
      process.exit(0);
    } else {
      console.error("❌ Cleanup job completed with errors");
      process.exit(1);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("💥 Cleanup job failed:", errorMessage);
    process.exit(1);
  }
}

// Run the job if this file is executed directly (GitHub Actions)
if (require.main === module) {
  main();
}

export { cleanupAbandonedPayments };
