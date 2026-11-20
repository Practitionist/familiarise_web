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
 * - jobs/reconcile-occurrence-availability.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-occurrence-availability/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { PaymentStatus, OccurrenceCompletionStatus } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { AUTO_REFUND_PENDING_PREFIX } from "@/lib/payments/webhooks/auto-refund-marker";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import { buildOccupiedAppointmentFilter } from "@/utils/scheduling-engine/occupancyPolicy";
import { reportStandingFinding } from "@/lib/observability/standing-finding";

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

  // #1424 — the sweep's own predicate, hoisted so the write can repeat it
  // (ADR 21: a sweep restates its money predicate in the WHERE it writes with).
  // The completion from-set is the point: a partial reschedule releases a slot
  // as isTentative=true / completionStatus=RESCHEDULED while leaving the parent
  // APPROVED, so the parent-status guard below does not see it. Stamping such a
  // slot confirmed blocks the consultant's calendar for a session nobody will
  // deliver. CANCELLED is excluded for the same reason.
  const CLEARABLE_COMPLETION_STATUSES: OccurrenceCompletionStatus[] = [
    OccurrenceCompletionStatus.SCHEDULED,
    OccurrenceCompletionStatus.COMPLETED,
    OccurrenceCompletionStatus.UNVERIFIED,
  ];
  const LIVE_TENTATIVE_SLOT = {
    isTentative: true,
    deletedAt: null,
    completionStatus: { in: CLEARABLE_COMPLETION_STATUSES },
  };

  try {
    // FIX #623: Find tentative slots with successful payments, but EXCLUDE
    // slots that are tentative due to an in-progress reschedule.
    // The reschedule workflow sets consultation/subscription status back to PENDING
    // while new slots are being selected. We must not clear those prematurely.
    const slotsToFix = await prisma.appointmentOccurrence.findMany({
      where: {
        ...LIVE_TENTATIVE_SLOT,
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
              // A capture parked for auto-refund (a double-booking loser) never confirms its slots.
              {
                payment: {
                  some: {
                    description: { startsWith: AUTO_REFUND_PENDING_PREFIX },
                  },
                },
              },
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
      // One write per row, repeating the cohort predicate: a row that left the
      // cohort is skipped, and an overlap with a confirmed row (23P01) skips
      // only that row; the double-booking scan below reports it.
      let cleared = 0;
      let overlapping = 0;
      for (const slot of slotsToFix) {
        try {
          const result = await prisma.appointmentOccurrence.updateMany({
            where: { id: slot.id, ...LIVE_TENTATIVE_SLOT },
            data: { isTentative: false },
          });
          cleared += result.count;
        } catch (error) {
          if (!isExclusionViolation(error)) throw error;
          overlapping += 1;
        }
      }

      console.log(`✅ Cleared tentative flag on ${cleared} slots`);
      if (overlapping > 0) {
        console.warn(
          JSON.stringify({
            event: "reconcile_tentative_clear_overlap",
            overlapping,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      if (cleared + overlapping < slotsToFix.length) {
        // Not an error: the skipped rows were rescheduled, cancelled or
        // soft-deleted mid-run and will be picked up by the cohort that owns
        // them. Logged so a persistent gap is visible rather than silent.
        console.warn(
          JSON.stringify({
            event: "reconcile_tentative_clear_raced",
            read: slotsToFix.length,
            cleared,
            skipped: slotsToFix.length - cleared - overlapping,
            note: "slots left the cohort between the read and the write",
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return { cleared, errors };
    }

    return { cleared: 0, errors };
  } catch (error) {
    const msg = `Failed to clear tentative flags: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { cleared: 0, errors };
  }
}

/** Ids carried in a drift report's extras; the count carries the rest. */
const DRIFT_SAMPLE_SIZE = 20;

/** One page of the double-booking scan (#1583 E-P1-10); see the caller. */
function readDoubleBookingPage(
  windowEnd: Date,
  take: number,
  cursor: string | undefined,
) {
  return prisma.appointmentOccurrence.findMany({
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
          trial: {
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
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take,
    ...pageArgs(cursor),
  });
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
  const conflictPairKeys: string[] = [];

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
    // Paged; the id tiebreak keeps the cursor stable across rows that share a
    // startsAt.
    const DOUBLE_BOOKING_PAGE = 500;
    const DOUBLE_BOOKING_MAX_PAGES = 40;
    const confirmedSlots: Awaited<ReturnType<typeof readDoubleBookingPage>> =
      [];
    let page = 0;
    let slotCursor: string | undefined;
    for (;;) {
      const rows = await readDoubleBookingPage(
        windowEnd,
        DOUBLE_BOOKING_PAGE,
        slotCursor,
      );
      confirmedSlots.push(...rows);
      page += 1;
      if (rows.length < DOUBLE_BOOKING_PAGE) break;
      if (page >= DOUBLE_BOOKING_MAX_PAGES) {
        // Every run restarts at page 0, so a tail past the cap stays unseen
        // until the earlier rows age out of the window; say so once per run.
        console.warn(
          `⚠️ Double-booking scan capped at ${page * DOUBLE_BOOKING_PAGE} slots`,
        );
        reportSentryMessage("Double-booking scan hit its page cap", {
          subsystem: "bookings",
          op: "reconcile-occurrence-availability",
          expected: true,
          level: "warning",
          extra: { scanned: page * DOUBLE_BOOKING_PAGE, windowEnd },
        });
        break;
      }
      slotCursor = nextCursor(rows);
    }

    console.log(`Checking ${confirmedSlots.length} confirmed future slots`);

    // Group slots by consultant
    const slotsByConsultant = new Map<
      string,
      Array<{
        slot: (typeof confirmedSlots)[0];
        consultantId: string;
        consultantProfileId: string;
        consultantName: string;
      }>
    >();

    for (const slot of confirmedSlots) {
      // FIX #625: Resolve consultant from all 5 appointment types
      const {
        consultation,
        subscription,
        webinar,
        class: classEvent,
        trial,
      } = slot.appointment;

      const consultantProfile =
        consultation?.consultationPlan.consultantProfile ||
        subscription?.subscriptionPlan.consultantProfile ||
        webinar?.webinarPlan.consultantProfile ||
        classEvent?.classPlan.consultantProfile ||
        trial?.consultantProfile;

      if (!consultantProfile) continue;

      const consultantId = consultantProfile.user.id;
      const consultantName = consultantProfile.user.name || "Unknown";

      if (!slotsByConsultant.has(consultantId)) {
        slotsByConsultant.set(consultantId, []);
      }
      slotsByConsultant.get(consultantId)!.push({
        slot,
        consultantId,
        consultantProfileId: consultantProfile.id,
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
          // #1583 E-P0-06 — a durable row per finding, not a log line and a
          // 207 nobody reads; the run-level Sentry message follows below.
          // Keyed on the unordered occurrence pair (correlationId) so hourly
          // re-runs do not pile up a row per run for the same conflict.
          // Code-point order, not localeCompare: a key derived from ids must not
          // depend on collation.
          const [lo, hi] =
            current.slot.id < next.slot.id
              ? [current.slot.id, next.slot.id]
              : [next.slot.id, current.slot.id];
          const pairKey = `double-booking:${lo}:${hi}`;
          conflictPairKeys.push(pairKey);
          const alreadyRecorded = await prisma.systemEvent.findFirst({
            where: { correlationId: pairKey },
            select: { id: true },
          });
          if (!alreadyRecorded) {
            await recordSystemErrorSafe({
              category: "BOOKING",
              summary: `double-booking detected for consultant ${current.consultantProfileId}`,
              err: new Error(
                `Overlapping occurrences ${current.slot.id} / ${next.slot.id}`,
              ),
              context: {
                consultantProfileId: current.consultantProfileId,
                occurrenceIds: [current.slot.id, next.slot.id],
                appointmentIds: doubleBooking.appointments,
              },
              correlationId: pairKey,
            });
          }

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
      const message = "Double bookings detected by the occurrence reconcile";
      await reportStandingFinding(
        {
          key: "reconcile-occurrence-availability:double-booking",
          ids: conflictPairKeys,
          message,
        },
        () =>
          reportSentryMessage(message, {
            subsystem: "bookings",
            op: "reconcile-occurrence-availability",
            expected: true,
            level: "warning",
            extra: {
              count: doubleBookings.length,
              pairs: conflictPairKeys.slice(0, DRIFT_SAMPLE_SIZE),
            },
          }),
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

// Declared return types keep each page's row type from depending on the
// cursor the previous page produced.
function nextCursor(rows: ReadonlyArray<{ id: string }>): string | undefined {
  return rows.length > 0 ? rows[rows.length - 1].id : undefined;
}

function pageArgs(cursor: string | undefined): {
  skip?: number;
  cursor?: { id: string };
} {
  return cursor ? { skip: 1, cursor: { id: cursor } } : {};
}

// One lock at the core, so every entry point shares it. Fail-open: each pass
// is repeat-safe, so a lost lease costs a duplicate read, never a wrong write.
export async function reconcileOccurrenceAvailability(): Promise<SlotReconciliationResult> {
  return withCronLock(
    "reconcile-occurrence-availability",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileSlotAvailabilityUnlocked(),
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

  // #1319 A9 — the only reader of the shadow participant table until the
  // reader flip: report divergence from the slot↔user join, never repair it.
  await logParticipantDrift();

  // Summary
  console.log("\n📊 Slot Availability Reconciliation Summary:");
  console.log(`   Tentative flags cleared: ${tentativeResult.cleared}`);
  console.log(`   Double bookings detected: ${doubleBookingResult.detected}`);

  if (doubleBookingResult.detected > 0) {
    console.log("\n🚨 MANUAL INTERVENTION REQUIRED:");
    console.log("   Double bookings need to be resolved manually!");
  }

  return {
    // `success` means the run completed; findings ride doubleBookingsDetected,
    // which the HTTP twin reports as 207 and the Actions wrapper exits 1 on. A
    // clean run with findings used to read as a failed run (500), which the
    // ticker would count as a failure.
    success: allErrors.length === 0,
    tentativeFlagsCleared: tentativeResult.cleared,
    doubleBookingsDetected: doubleBookingResult.detected,
    doubleBookings: doubleBookingResult.bookings,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * #1319 A9 / #1554 — AppointmentParticipant is the only roster, so the drift
 * signal is an upcoming appointment with live occurrences and NO live seat:
 * every creation path writes the participant rows in the same transaction, so
 * an empty roster means a writer was missed, which is a bug to fix at the
 * source rather than a row to patch. Detect-only: one report per run when the
 * set has an appointment not already reported inside the standing window.
 */
async function logParticipantDrift(): Promise<void> {
  const windowEnd = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const appointments = await prisma.appointment.findMany({
    where: {
      deletedAt: null,
      occurrences: {
        some: {
          endsAt: { gt: new Date() },
          startsAt: { lt: windowEnd },
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        },
      },
      participants: { none: liveParticipant() },
    },
    select: { id: true, appointmentType: true },
    take: 2000,
  });

  for (const appointment of appointments) {
    console.log(
      JSON.stringify({
        event: "participant_drift",
        appointmentId: appointment.id,
        appointmentType: appointment.appointmentType,
        reason: "no live participant row on an upcoming appointment",
        timestamp: new Date().toISOString(),
      }),
    );
  }
  console.log(
    `   Participant drift: ${appointments.length} upcoming appointment(s) without a live seat`,
  );
  if (appointments.length === 0) return;
  const message = "Upcoming appointments with no live participant row";
  await reportStandingFinding(
    {
      key: "reconcile-occurrence-availability:participant-drift",
      ids: appointments.map((a) => a.id),
      message,
    },
    () =>
      reportSentryMessage(message, {
        subsystem: "bookings",
        op: "reconcile-occurrence-availability.participant-drift",
        level: "warning",
        extra: {
          count: appointments.length,
          appointmentIds: appointments
            .slice(0, DRIFT_SAMPLE_SIZE)
            .map((a) => a.id),
        },
      }),
  );
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
