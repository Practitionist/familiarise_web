/**
 * Slot Availability Reconciliation - Core Logic
 *
 * Fixes slot availability inconsistencies:
 * 1. Clears isTentative flag on slots with successful payments
 * 2. Detects double-booked slots (overlapping confirmed bookings)
 *
 * This catches cases where:
 * - Payment succeeded but isTentative wasn't cleared
 * - Race condition caused overlapping bookings
 * - System error left slots in inconsistent state
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-slot-availability.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-slot-availability/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../lib/prisma";
import { PaymentStatus } from "@prisma/client";

export interface SlotReconciliationResult {
  success: boolean;
  tentativeFlagsCleared: number;
  doubleBookingsDetected: number;
  doubleBookings: DoubleBookingInfo[];
  errors: string[];
  timestamp: string;
}

interface DoubleBookingInfo {
  consultantId: string;
  consultantName: string;
  slotTime: string;
  appointments: string[];
}

/**
 * Clear isTentative flag on slots with successful payments
 */
async function clearTentativeOnSuccessfulPayments(): Promise<{
  cleared: number;
  errors: string[];
}> {
  const errors: string[] = [];

  console.log("🔍 Finding tentative slots with successful payments...");

  try {
    // Find slots marked tentative but payment succeeded
    const slotsToFix = await prisma.slotOfAppointment.findMany({
      where: {
        isTentative: true,
        appointment: {
          payment: {
            some: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
        },
      },
      include: {
        appointment: {
          include: {
            payment: { select: { id: true, paymentStatus: true } },
            consultation: { select: { id: true } },
          },
        },
      },
    });

    console.log(`Found ${slotsToFix.length} tentative slots with successful payments`);

    for (const slot of slotsToFix) {
      console.log(`\nFixing slot ${slot.id}`);
      console.log(`   Appointment: ${slot.appointmentId}`);
      console.log(`   Time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`);
    }

    if (slotsToFix.length > 0) {
      // Bulk update to clear tentative flag
      const result = await prisma.slotOfAppointment.updateMany({
        where: {
          isTentative: true,
          appointment: {
            payment: {
              some: {
                paymentStatus: PaymentStatus.SUCCEEDED,
              },
            },
          },
        },
        data: { isTentative: false },
      });

      console.log(`✅ Cleared tentative flag on ${result.count} slots`);
      return { cleared: result.count, errors };
    }

    return { cleared: 0, errors };
  } catch (error) {
    const msg = `Failed to clear tentative flags: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { cleared: 0, errors };
  }
}

/**
 * Detect double-booked slots (overlapping confirmed bookings for same consultant)
 */
async function detectDoubleBookings(): Promise<{
  detected: number;
  bookings: DoubleBookingInfo[];
  errors: string[];
}> {
  const errors: string[] = [];
  const doubleBookings: DoubleBookingInfo[] = [];

  console.log("\n🔍 Detecting double-booked slots...");

  try {
    // Get all confirmed (non-tentative) future slots grouped by consultant
    const confirmedSlots = await prisma.slotOfAppointment.findMany({
      where: {
        isTentative: false,
        endsAt: { gt: new Date() }, // Only future slots
        appointment: {
          payment: {
            some: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
        },
      },
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: { select: { id: true, name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { startsAt: "asc" },
    });

    console.log(`Checking ${confirmedSlots.length} confirmed future slots`);

    // Group slots by consultant
    const slotsByConsultant = new Map<
      string,
      Array<{
        slot: typeof confirmedSlots[0];
        consultantId: string;
        consultantName: string;
      }>
    >();

    for (const slot of confirmedSlots) {
      const consultation = slot.appointment.consultation;
      const subscription = slot.appointment.subscription;

      const consultantProfile =
        consultation?.consultationPlan.consultantProfile ||
        subscription?.subscriptionPlan.consultantProfile;

      if (!consultantProfile) continue;

      const consultantId = consultantProfile.user.id;
      const consultantName = consultantProfile.user.name || "Unknown";

      if (!slotsByConsultant.has(consultantId)) {
        slotsByConsultant.set(consultantId, []);
      }
      slotsByConsultant.get(consultantId)!.push({
        slot,
        consultantId,
        consultantName,
      });
    }

    // Check for overlaps within each consultant's slots
    for (const [consultantId, slots] of slotsByConsultant) {
      // Sort by start time
      slots.sort((a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime());

      for (let i = 0; i < slots.length - 1; i++) {
        const current = slots[i];
        const next = slots[i + 1];

        // Check if slots overlap
        if (current.slot.endsAt > next.slot.startsAt) {
          // Double booking detected!
          const doubleBooking: DoubleBookingInfo = {
            consultantId,
            consultantName: current.consultantName,
            slotTime: `${current.slot.startsAt.toISOString()} - ${current.slot.endsAt.toISOString()}`,
            appointments: [current.slot.appointmentId, next.slot.appointmentId],
          };

          doubleBookings.push(doubleBooking);

          console.log(`\n🚨 DOUBLE BOOKING DETECTED:`);
          console.log(`   Consultant: ${current.consultantName}`);
          console.log(`   Slot 1: ${current.slot.id} (${current.slot.startsAt.toISOString()} - ${current.slot.endsAt.toISOString()})`);
          console.log(`   Slot 2: ${next.slot.id} (${next.slot.startsAt.toISOString()} - ${next.slot.endsAt.toISOString()})`);
          console.log(`   Appointments: ${current.slot.appointmentId}, ${next.slot.appointmentId}`);
        }
      }
    }

    if (doubleBookings.length === 0) {
      console.log("✅ No double bookings detected");
    } else {
      console.log(`\n⚠️ Found ${doubleBookings.length} double booking conflicts`);
    }

    return { detected: doubleBookings.length, bookings: doubleBookings, errors };
  } catch (error) {
    const msg = `Failed to detect double bookings: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { detected: 0, bookings: [], errors };
  }
}

/**
 * Main function to reconcile slot availability
 */
export async function reconcileSlotAvailability(): Promise<SlotReconciliationResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting slot availability reconciliation...");

  // Clear tentative flags on successful payments
  const tentativeResult = await clearTentativeOnSuccessfulPayments();
  allErrors.push(...tentativeResult.errors);

  // Detect double bookings
  const doubleBookingResult = await detectDoubleBookings();
  allErrors.push(...doubleBookingResult.errors);

  // Summary
  console.log("\n📊 Slot Availability Reconciliation Summary:");
  console.log(`   Tentative flags cleared: ${tentativeResult.cleared}`);
  console.log(`   Double bookings detected: ${doubleBookingResult.detected}`);

  if (doubleBookingResult.detected > 0) {
    console.log("\n🚨 MANUAL INTERVENTION REQUIRED:");
    console.log("   Double bookings need to be resolved manually!");
  }

  return {
    success: allErrors.length === 0 && doubleBookingResult.detected === 0,
    tentativeFlagsCleared: tentativeResult.cleared,
    doubleBookingsDetected: doubleBookingResult.detected,
    doubleBookings: doubleBookingResult.bookings,
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
