import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { PaymentIntentManager } from "@/utils/payments";
import { ErrorLogger } from "@/utils/errorHandling";

// Comprehensive payment cleanup service
export class PaymentCleanupService {
  // Clean up expired and abandoned payment intents
  static async cleanupExpiredPayments(): Promise<{
    expiredPayments: number;
    cancelledIntents: number;
    cleanedSlots: number;
  }> {
    ErrorLogger.info("Starting payment cleanup job");

    const now = new Date();
    let expiredPayments = 0;
    let cancelledIntents = 0;
    let cleanedSlots = 0;

    try {
      // Find all expired pending payments
      const expiredPaymentRecords = await prisma.payment.findMany({
        where: {
          paymentStatus: PaymentStatus.PENDING,
          OR: [
            { expiresAt: { lte: now } }, // Explicitly expired
            {
              AND: [
                { expiresAt: null }, // No expiration set
                { createdAt: { lte: new Date(now.getTime() - 30 * 60 * 1000) } }, // Older than 30 minutes
              ],
            },
          ],
        },
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                where: { isTentative: true },
              },
              consultation: true,
              subscription: true,
              webinar: true,
              class: true,
            },
          },
        },
      });

      ErrorLogger.info(`Found ${expiredPaymentRecords.length} expired payments`);

      // Process each expired payment
      for (const payment of expiredPaymentRecords) {
        await prisma.$transaction(async (tx) => {
          try {
            // 1. Update payment status to failed
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                paymentStatus: PaymentStatus.FAILED,
                description: "Payment expired - automatically cleaned up",
              },
            });
            expiredPayments++;

            // 2. Cancel payment intent at gateway level
            try {
              await PaymentIntentManager.cleanup(
                payment.paymentIntent,
                "Payment expired - cleanup job",
              );
              cancelledIntents++;
            } catch (cancelError) {
              ErrorLogger.warn("Failed to cancel payment intent", {
                paymentIntentId: payment.paymentIntent,
                error: cancelError,
              });
            }

            // 3. Clean up associated tentative appointments and slots
            if (payment.appointment) {
              const appointment = payment.appointment;

              // Remove tentative slots
              if (appointment.slotsOfAppointment.length > 0) {
                await tx.slotOfAppointment.deleteMany({
                  where: {
                    appointmentId: appointment.id,
                    isTentative: true,
                  },
                });
                cleanedSlots += appointment.slotsOfAppointment.length;
              }

              // Check if appointment has any remaining slots
              const remainingSlots = await tx.slotOfAppointment.count({
                where: { appointmentId: appointment.id },
              });

              // If no remaining slots, clean up the appointment and related records
              if (remainingSlots === 0) {
                if (appointment.consultation) {
                  await tx.consultation.delete({
                    where: { id: appointment.consultation.id },
                  });
                }

                if (appointment.subscription) {
                  await tx.subscription.delete({
                    where: { id: appointment.subscription.id },
                  });
                }

                // For webinars and classes, don't delete the event itself,
                // just remove the appointment association
                if (appointment.webinar) {
                  await tx.webinar.update({
                    where: { id: appointment.webinar.id },
                    data: { appointment: { disconnect: true } },
                  });
                }

                if (appointment.class) {
                  await tx.class.update({
                    where: { id: appointment.class.id },
                    data: { appointments: { disconnect: { id: appointment.id } } },
                  });
                }

                // Finally, delete the appointment
                await tx.appointment.delete({
                  where: { id: appointment.id },
                });
              }
            }

            ErrorLogger.info("Cleaned up expired payment", {
              paymentId: payment.id,
              paymentIntentId: payment.paymentIntent,
              appointmentId: payment.appointment?.id,
            });
          } catch (cleanupError) {
            ErrorLogger.error("Failed to cleanup individual payment", cleanupError, {
              paymentId: payment.id,
            });
            // Continue with other payments even if one fails
          }
        });
      }

      ErrorLogger.info("Payment cleanup job completed", {
        expiredPayments,
        cancelledIntents,
        cleanedSlots,
      });

      return {
        expiredPayments,
        cancelledIntents,
        cleanedSlots,
      };
    } catch (error) {
      ErrorLogger.error("Payment cleanup job failed", error);
      throw error;
    }
  }

  // Clean up orphaned slots (slots without valid payments)
  static async cleanupOrphanedSlots(): Promise<{ orphanedSlots: number }> {
    ErrorLogger.info("Starting orphaned slots cleanup");

    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      // Find tentative slots that don't have valid pending payments
      const orphanedSlots = await prisma.slotOfAppointment.findMany({
        where: {
          isTentative: true,
          createdAt: { lte: thirtyMinutesAgo },
          appointment: {
            payment: {
              none: {
                paymentStatus: PaymentStatus.PENDING,
                expiresAt: { gt: new Date() },
              },
            },
          },
        },
        include: {
          appointment: {
            include: {
              payment: true,
              consultation: true,
              subscription: true,
            },
          },
        },
      });

      let cleanedCount = 0;

      for (const slot of orphanedSlots) {
        await prisma.$transaction(async (tx) => {
          // Delete the orphaned slot
          await tx.slotOfAppointment.delete({
            where: { id: slot.id },
          });

          // Check if appointment has any remaining slots
          const remainingSlots = await tx.slotOfAppointment.count({
            where: { appointmentId: slot.appointmentId },
          });

          // If no remaining slots, clean up the appointment
          if (remainingSlots === 0) {
            const appointment = slot.appointment;

            if (appointment.consultation) {
              await tx.consultation.delete({
                where: { id: appointment.consultation.id },
              });
            }

            if (appointment.subscription) {
              await tx.subscription.delete({
                where: { id: appointment.subscription.id },
              });
            }

            await tx.appointment.delete({
              where: { id: appointment.id },
            });
          }

          cleanedCount++;
        });
      }

      ErrorLogger.info("Orphaned slots cleanup completed", {
        orphanedSlots: cleanedCount,
      });

      return { orphanedSlots: cleanedCount };
    } catch (error) {
      ErrorLogger.error("Orphaned slots cleanup failed", error);
      throw error;
    }
  }

  // Resolve payment conflicts (multiple pending payments for same slot)
  static async resolvePaymentConflicts(): Promise<{ resolvedConflicts: number }> {
    ErrorLogger.info("Starting payment conflict resolution");

    try {
      // Find slots with multiple pending payments
      const conflictingSlots = await prisma.slotOfAppointment.findMany({
        where: {
          isTentative: true,
          appointment: {
            payment: {
              some: {
                paymentStatus: PaymentStatus.PENDING,
              },
            },
          },
        },
        include: {
          appointment: {
            include: {
              payment: {
                where: {
                  paymentStatus: PaymentStatus.PENDING,
                },
                orderBy: {
                  createdAt: "asc", // Oldest first
                },
              },
            },
          },
        },
      });

      let resolvedConflicts = 0;

      // Group slots by time range to find actual conflicts
      const timeSlotGroups = new Map<string, typeof conflictingSlots>();

      for (const slot of conflictingSlots) {
        const timeKey = `${slot.startsAt.getTime()}-${slot.endsAt.getTime()}`;
        if (!timeSlotGroups.has(timeKey)) {
          timeSlotGroups.set(timeKey, []);
        }
        timeSlotGroups.get(timeKey)!.push(slot);
      }

      // Resolve conflicts for each time slot
      for (const [timeKey, slots] of Array.from(timeSlotGroups)) {
        if (slots.length > 1) {
          // Keep the earliest payment, cancel others
          const paymentsToCancel = slots.slice(1); // All except the first

          for (const slotToCancel of paymentsToCancel) {
            for (const payment of slotToCancel.appointment.payment) {
              await prisma.$transaction(async (tx) => {
                // Cancel the payment
                await tx.payment.update({
                  where: { id: payment.id },
                  data: {
                    paymentStatus: PaymentStatus.FAILED,
                    description: "Cancelled due to booking conflict - first-come-first-served",
                  },
                });

                // Cancel payment intent
                try {
                  await PaymentIntentManager.cleanup(
                    payment.paymentIntent,
                    "Booking conflict resolution",
                  );
                } catch (cancelError) {
                  ErrorLogger.warn("Failed to cancel conflicting payment intent", {
                    paymentIntentId: payment.paymentIntent,
                    error: cancelError,
                  });
                }

                // Remove the slot and appointment
                await tx.slotOfAppointment.delete({
                  where: { id: slotToCancel.id },
                });

                const remainingSlots = await tx.slotOfAppointment.count({
                  where: { appointmentId: slotToCancel.appointmentId },
                });

                if (remainingSlots === 0) {
                  await tx.appointment.delete({
                    where: { id: slotToCancel.appointmentId },
                  });
                }

                resolvedConflicts++;
              });
            }
          }

          ErrorLogger.info("Resolved payment conflict", {
            timeSlot: timeKey,
            conflictingPayments: slots.length,
            cancelledPayments: paymentsToCancel.length,
          });
        }
      }

      ErrorLogger.info("Payment conflict resolution completed", {
        resolvedConflicts,
      });

      return { resolvedConflicts };
    } catch (error) {
      ErrorLogger.error("Payment conflict resolution failed", error);
      throw error;
    }
  }

  // Get statistics about payments that need cleanup
  static async getCleanupStatistics(): Promise<{
    expiredPendingPayments: number;
    orphanedTentativeSlots: number;
    conflictingTimeSlots: number;
    oldestPendingPayment: Date | null;
  }> {
    try {
      const now = new Date();
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

      // Count expired pending payments
      const expiredPendingPayments = await prisma.payment.count({
        where: {
          paymentStatus: PaymentStatus.PENDING,
          OR: [
            { expiresAt: { lte: now } },
            {
              AND: [
                { expiresAt: null },
                { createdAt: { lte: thirtyMinutesAgo } },
              ],
            },
          ],
        },
      });

      // Count orphaned tentative slots
      const orphanedTentativeSlots = await prisma.slotOfAppointment.count({
        where: {
          isTentative: true,
          createdAt: { lte: thirtyMinutesAgo },
          appointment: {
            payment: {
              none: {
                paymentStatus: PaymentStatus.PENDING,
                expiresAt: { gt: now },
              },
            },
          },
        },
      });

      // Get oldest pending payment
      const oldestPayment = await prisma.payment.findFirst({
        where: {
          paymentStatus: PaymentStatus.PENDING,
        },
        orderBy: {
          createdAt: "asc",
        },
        select: {
          createdAt: true,
        },
      });

      return {
        expiredPendingPayments,
        orphanedTentativeSlots,
        conflictingTimeSlots: 0, // This would require a more complex query
        oldestPendingPayment: oldestPayment?.createdAt ?? null,
      };
    } catch (error) {
      ErrorLogger.error("Failed to get cleanup statistics", error);
      throw error;
    }
  }

  // Run comprehensive cleanup (all cleanup methods)
  static async runComprehensiveCleanup() {
    ErrorLogger.info("Starting comprehensive payment cleanup");

    const results = {
      expiredPayments: 0,
      cancelledIntents: 0,
      cleanedSlots: 0,
      orphanedSlots: 0,
      resolvedConflicts: 0,
      startTime: new Date(),
      endTime: null as Date | null,
      duration: 0,
    };

    try {
      // 1. Clean up expired payments
      const expiredResults = await this.cleanupExpiredPayments();
      results.expiredPayments = expiredResults.expiredPayments;
      results.cancelledIntents = expiredResults.cancelledIntents;
      results.cleanedSlots += expiredResults.cleanedSlots;

      // 2. Clean up orphaned slots
      const orphanedResults = await this.cleanupOrphanedSlots();
      results.orphanedSlots = orphanedResults.orphanedSlots;

      // 3. Resolve payment conflicts
      const conflictResults = await this.resolvePaymentConflicts();
      results.resolvedConflicts = conflictResults.resolvedConflicts;

      results.endTime = new Date();
      results.duration = results.endTime.getTime() - results.startTime.getTime();

      ErrorLogger.info("Comprehensive payment cleanup completed successfully", results);

      return results;
    } catch (error) {
      results.endTime = new Date();
      results.duration = results.endTime.getTime() - results.startTime.getTime();

      ErrorLogger.error("Comprehensive payment cleanup failed", error, results);
      throw error;
    }
  }
}

// Export for cron job usage
export async function runPaymentCleanup() {
  return await PaymentCleanupService.runComprehensiveCleanup();
}