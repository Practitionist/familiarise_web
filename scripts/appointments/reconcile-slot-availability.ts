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

import prisma from "../../lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";

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
    // FIX #623: Find tentative slots with successful payments, but EXCLUDE
    // slots that are tentative due to an in-progress reschedule.
    // The reschedule workflow sets consultation/subscription status back to PENDING
    // while new slots are being selected. We must not clear those prematurely.
    const slotsToFix = await prisma.slotOfAppointment.findMany({
      where: {
        isTentative: true,
        appointment: {
          payment: {
            some: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
          // FIX #623: Only clear tentative on consultation/subscription appointments
          // where tentative = "payment succeeded but flag wasn't cleared".
          // Webinar/class are intentionally excluded because:
          // 1. Their reschedule marks ALL slots tentative with no status signal
          //    to distinguish "stale payment" from "reschedule-in-progress"
          // 2. Without a reliable discriminator, clearing would break reschedules
          // Trade-off: stale webinar/class tentative slots won't auto-heal here,
          // but that's safer than breaking active reschedules. A future
          // `tentativeReason` column would let us reconcile all event types.
          OR: [
            { consultationId: { not: null } },
            { subscriptionId: { not: null } },
          ],
          NOT: {
            OR: [
              { consultation: { status: "PENDING" } },
              { subscription: { status: "PENDING" } },
            ],
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

    console.log(
      `Found ${slotsToFix.length} tentative slots with successful payments`,
    );

    for (const slot of slotsToFix) {
      console.log(`\nFixing slot ${slot.id}`);
      console.log(`   Appointment: ${slot.appointmentId}`);
      console.log(
        `   Time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
      );
    }

    if (slotsToFix.length > 0) {
      // Bulk update to clear tentative flag — use exact IDs from the filtered query
      // to ensure we don't accidentally clear reschedule-in-progress slots.
      const result = await prisma.slotOfAppointment.updateMany({
        where: {
          id: { in: slotsToFix.map((s) => s.id) },
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
    // Get all future slots whose parent event is in an occupied state, grouped
    // by consultant. Occupancy is defined by the canonical policy
    // (buildOccupiedAppointmentFilter), not by a SUCCEEDED-payment filter, so
    // overlaps involving unpaid/tentative holds (PENDING, APPROVED,
    // APPROVED_PENDING_PAYMENT) are caught too — the old payment-only query
    // missed them.
    // #1169 PR 6 — window-bound: reconciling ALL future slots scans without
    // limit as the book grows; overlaps meaningfully surface within the
    // scheduling horizon, and later runs cover later windows.
    const RECONCILE_WINDOW_DAYS = 60;
    const windowEnd = new Date(
      Date.now() + RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const confirmedSlots = await prisma.slotOfAppointment.findMany({
      where: {
        endsAt: { gt: new Date() }, // Only future slots
        startsAt: { lt: windowEnd },
        appointment: {
          AND: [
            { OR: buildOccupiedAppointmentFilter() },
            // Exclude legitimately in-flight tentative holds. A consultation/
            // subscription reset to PENDING is either awaiting first approval or
            // mid-reschedule (#623) — its slots are transient and self-resolve, so
            // flagging them is report noise, not a real double-booking. We still
            // catch APPROVED_PENDING_PAYMENT (unpaid but committed) overlaps, which
            // is the widening this detector was changed to cover.
            {
              NOT: {
                OR: [
                  { consultation: { status: "PENDING" } },
                  { subscription: { status: "PENDING" } },
                ],
              },
            },
          ],
        },
      },
      // FIX #625: Include all 5 appointment types (not just consultation/subscription)
      // so webinar and class overlaps are also detected. Note: trial sessions
      // typically lack SUCCEEDED payments, so they won't match this query's
      // payment filter — their inclusion here is for consultant resolution only.
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
            webinar: {
              include: {
                webinarPlan: {
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
            class: {
              include: {
                classPlan: {
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
            trialSession: {
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
      orderBy: { startsAt: "asc" },
    });

    console.log(`Checking ${confirmedSlots.length} confirmed future slots`);

    // Group slots by consultant
    const slotsByConsultant = new Map<
      string,
      Array<{
        slot: (typeof confirmedSlots)[0];
        consultantId: string;
        consultantName: string;
      }>
    >();

    for (const slot of confirmedSlots) {
      // FIX #625: Resolve consultant from all 5 appointment types
      const { consultation, subscription, webinar, class: classEvent, trialSession } =
        slot.appointment;

      const consultantProfile =
        consultation?.consultationPlan.consultantProfile ||
        subscription?.subscriptionPlan.consultantProfile ||
        webinar?.webinarPlan.consultantProfile ||
        classEvent?.classPlan.consultantProfile ||
        trialSession?.consultantProfile;

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
    for (const [consultantId, slots] of Array.from(
      slotsByConsultant.entries(),
    )) {
      // Sort by start time
      const sortedSlots = [...slots].sort(
        (a: { slot: { startsAt: Date } }, b: { slot: { startsAt: Date } }) =>
          a.slot.startsAt.getTime() - b.slot.startsAt.getTime(),
      );

      for (let i = 0; i < sortedSlots.length - 1; i++) {
        const current = sortedSlots[i];
        const next = sortedSlots[i + 1];

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
          console.log(
            `   Slot 1: ${current.slot.id} (${current.slot.startsAt.toISOString()} - ${current.slot.endsAt.toISOString()})`,
          );
          console.log(
            `   Slot 2: ${next.slot.id} (${next.slot.startsAt.toISOString()} - ${next.slot.endsAt.toISOString()})`,
          );
          console.log(
            `   Appointments: ${current.slot.appointmentId}, ${next.slot.appointmentId}`,
          );
        }
      }
    }

    if (doubleBookings.length === 0) {
      console.log("✅ No double bookings detected");
    } else {
      console.log(
        `\n⚠️ Found ${doubleBookings.length} double booking conflicts`,
      );
    }

    return {
      detected: doubleBookings.length,
      bookings: doubleBookings,
      errors,
    };
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
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function reconcileSlotAvailability(): Promise<SlotReconciliationResult> {
  return withCronLock("reconcile-slot-availability", { failMode: "open", ttlMs: LONG_JOB_TTL_MS }, () =>
    reconcileSlotAvailabilityUnlocked(),
  );
}

async function reconcileSlotAvailabilityUnlocked(): Promise<SlotReconciliationResult> {
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
