/**
 * Tentative Slot Cleanup - Core Logic
 *
 * Releases slots marked as isTentative=true that are associated with
 * abandoned booking flows (no successful payment after 7 days).
 *
 * This happens when:
 * - User started booking but never completed payment
 * - Payment failed and user abandoned checkout
 * - System error prevented slot release after payment failure
 *
 * This module exports the core cleanup function.
 * It is imported by:
 * - jobs/cleanup-tentative-slots.ts (GitHub Actions)
 * - app/api/cleanup/tentative-slots/route.ts (API endpoint)
 *
 * Schedule: Every 2 hours
 */

import prisma from "../../lib/prisma";
import { PaymentStatus } from "@prisma/client";

// Release tentative slots older than 7 days with no successful payment
const TENTATIVE_EXPIRATION_DAYS = 7;

export interface TentativeSlotCleanupResult {
  success: boolean;
  slotsReleased: number;
  appointmentsAffected: number;
  errors: string[];
  timestamp: string;
}

/**
 * Find and release stale tentative slots
 */
export async function cleanupTentativeSlots(): Promise<TentativeSlotCleanupResult> {
  const errors: string[] = [];
  let slotsReleased = 0;
  const appointmentsAffected = new Set<string>();

  const expirationDate = new Date(
    Date.now() - TENTATIVE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  console.log("🧹 Starting tentative slot cleanup...");
  console.log(`   Expiration threshold: ${TENTATIVE_EXPIRATION_DAYS} days`);

  try {
    // Find tentative slots with no successful payment
    const staleTentativeSlots = await prisma.slotOfAppointment.findMany({
      where: {
        isTentative: true,
        createdAt: { lt: expirationDate },
        appointment: {
          payment: {
            none: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
        },
      },
      include: {
        appointment: {
          include: {
            payment: { select: { id: true, paymentStatus: true } },
            consultation: {
              select: {
                id: true,
                requestStatus: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
            subscription: {
              select: {
                id: true,
                requestStatus: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
          },
        },
      },
    });

    console.log(`Found ${staleTentativeSlots.length} stale tentative slots`);

    for (const slot of staleTentativeSlots) {
      console.log(`\nProcessing tentative slot ${slot.id}`);
      console.log(`   Appointment ID: ${slot.appointmentId}`);
      console.log(`   Created: ${slot.createdAt.toISOString()}`);
      console.log(
        `   Slot time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
      );

      // Get user info
      const consultation = slot.appointment.consultation;
      const subscription = slot.appointment.subscription;
      const user =
        consultation?.requestedBy?.user || subscription?.requestedBy?.user;
      console.log(
        `   User: ${user?.name || "Unknown"} (${user?.email || "N/A"})`,
      );

      // Log payment status
      const payments = slot.appointment.payment;
      if (payments.length === 0) {
        console.log(`   Payment: None`);
      } else {
        payments.forEach((p) => {
          console.log(`   Payment ${p.id}: ${p.paymentStatus}`);
        });
      }

      appointmentsAffected.add(slot.appointmentId);
    }

    // Delete the stale tentative slots to release consultant availability
    if (staleTentativeSlots.length > 0) {
      const result = await prisma.slotOfAppointment.deleteMany({
        where: {
          isTentative: true,
          createdAt: { lt: expirationDate },
          appointment: {
            payment: {
              none: {
                paymentStatus: PaymentStatus.SUCCEEDED,
              },
            },
          },
        },
      });

      slotsReleased = result.count;
      console.log(`\n✅ Released ${slotsReleased} tentative slots`);
    }

    // Summary
    console.log("\n📊 Tentative Slot Cleanup Summary:");
    console.log(`   Slots released: ${slotsReleased}`);
    console.log(`   Appointments affected: ${appointmentsAffected.size}`);
  } catch (error) {
    const msg = `Failed to cleanup tentative slots: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  return {
    success: errors.length === 0,
    slotsReleased,
    appointmentsAffected: appointmentsAffected.size,
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
