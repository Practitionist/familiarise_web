// Checkout's occupancy checks: published coverage, and the consultant's
// and the consultee's calendars.

import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "@/utils/scheduling-engine/availabilityCoverage";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { Prisma } from "@prisma/client";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";
import {
  buildConsultantOccupancyWhere,
  buildDeadSeatFilter,
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
  OCCUPYING_OCCURRENCE_WHERE,
} from "@/utils/scheduling-engine/occupancyPolicy";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { SlotTakenError } from "@/lib/booking/booking-rule-error";
import {
  buildLiveHoldPaymentFilter,
  findSelfHoldAppointmentIds,
} from "@/lib/payments/checkout/self-hold";

/**
 * Validate slot availability with protection against race conditions
 * Checks for:
 * 1. Confirmed overlapping bookings
 * 2. Duplicate tentative bookings by same user
 * 3. Excessive tentative bookings (rate limiting)
 *
 * #1463 — returns the buyer's own self-held appointment ids so the caller's
 * own conflict checks can exclude the same rows this function did; re-deriving
 * them there would be a second query answering an identical question.
 */
export async function validateSlotAvailability(
  tx: Tx,
  data: CheckoutInput,
  buyerUserId?: string,
  consultantUserId?: string, // NEW: Filter by consultant to prevent blocking across different consultants
  /**
   * #1465-triage — the SERVER-resolved org scope for this request, which is
   * what `findReusablePendingOrderPayment` matches on. Defaults to null
   * (personal) so a caller that cannot resolve it fails closed: an org-scoped
   * hold then keeps blocking rather than being excluded from availability by a
   * request that could never resume it.
   */
  organizationId: string | null = null,
  consultantProfileId?: string,
): Promise<{ selfHoldAppointmentIds: string[] }> {
  if (!data.startsAt || !data.endsAt) return { selfHoldAppointmentIds: [] };

  // LCY-2 consent cascade (#701/#1230) — a consultant who withdrew
  // SESSION_BOOKING consent must not receive new bookings. Fail-closed:
  // no artifact or withdrawn artifact ⇒ block.
  if (consultantUserId) {
    // #1421 — `tx`, not the global client. Every caller of this helper is
    // already inside an interactive transaction, and under PG_POOL_MAX=1 that
    // transaction holds the pool's only connection: a global-client read here
    // waits for a connection that cannot be freed until the transaction it is
    // blocking commits, so checkout died at the 3 s pg connect timeout with
    // "timeout exceeded when trying to connect". The dynamic imports this
    // block used to carry are gone too; both symbols are static imports above.
    if (
      !(await checkConsent(
        {
          userId: consultantUserId,
          purposeCode: PURPOSE_CODES.SESSION_BOOKING,
        },
        tx,
      ))
    ) {
      throw Object.assign(
        new Error("This expert isn't taking bookings right now."),
        { httpStatus: 403, code: "CONSENT_WITHDRAWN" },
      );
    }
  }

  const slotStart = new Date(data.startsAt);
  const slotEnd = new Date(data.endsAt);
  const now = new Date();

  // 0. Validate slot is not in the past or too soon (minimum lead time check)
  const timingError = validateSlotTiming(slotStart);
  if (timingError) {
    throw new Error(timingError);
  }

  // 0b. Validate the whole [start, end) window against the consultant's
  // PUBLISHED availability. #1320 — this used to check the window against the
  // single row the client named (`availabilityWindowWeeklyId`), so a two-hour
  // booking spanning two adjacent one-hour rows was rejected even though the
  // expert-page grid drew them as one block and the generator now merges
  // them. The rule is now interval containment against the UNION of the
  // consultant's rows: every 30-minute atom of the window must fall inside
  // some published row. The named id, when present, still proves ownership
  // and catches a soft-deleted profile (B13); it is no longer the boundary.
  let resolvedProfileId = consultantProfileId;
  if (data.availabilityWindowWeeklyId || data.availabilityWindowCustomId) {
    // Both row kinds are read for the same three facts, so they share one
    // include; a checkout names at most one of them.
    const namedRowInclude = {
      consultantProfile: {
        select: { id: true, userId: true, deletedAt: true },
      },
    } as const;
    const named =
      (data.availabilityWindowWeeklyId
        ? await tx.availabilityWindowWeekly.findUnique({
            where: { id: data.availabilityWindowWeeklyId },
            include: namedRowInclude,
          })
        : null) ??
      (data.availabilityWindowCustomId
        ? await tx.availabilityWindowCustom.findUnique({
            where: { id: data.availabilityWindowCustomId },
            include: namedRowInclude,
          })
        : null);
    // A named row can legitimately vanish mid-checkout: a save on the
    // consultant's side coalesces adjacent rows into one and re-ids it. The
    // union check below is the authority, so a missing row is not fatal
    // unless we cannot resolve the consultant at all.
    if (named) {
      if (named.consultantProfile.deletedAt) {
        throw new Error("This expert is no longer accepting bookings");
      }
      if (
        consultantUserId &&
        named.consultantProfile.userId !== consultantUserId
      ) {
        throw new Error(
          "Availability slot does not belong to the specified consultant",
        );
      }
    }
    const profileId =
      named?.consultantProfile.id ??
      resolvedProfileId ??
      (consultantUserId
        ? (
            await tx.consultantProfile?.findFirst({
              // The named row got its deletedAt check above; this fallback
              // runs when there is no named row, so it carries its own.
              where: { userId: consultantUserId, deletedAt: null },
              select: { id: true },
            })
          )?.id
        : undefined);
    if (!profileId) {
      throw new Error("Availability slot not found");
    }
    resolvedProfileId = profileId;

    const atoms = windowAtoms(slotStart, slotEnd);
    // ScheduleType is exclusive, so only the consultant's active arm publishes
    // availability; the loader hands back [] for the dormant one (#1320).
    const { scheduleType, weeklyRows, customRows } =
      await loadPublishedCoverage(tx, profileId, slotStart, slotEnd);
    const uncovered = findUncoveredAtom(atoms, weeklyRows, customRows);

    if (uncovered) {
      // FIX #520 Bug 2: Diagnostic logging for intermittent slot validation failures
      console.error(
        JSON.stringify({
          event: "slot_validation_failed",
          reason: "atom_outside_published_availability",
          scheduleType,
          uncoveredAtomStart: uncovered.start.toISOString(),
          candidateDay: uncovered.day,
          candidateMinutes: uncovered.minutes,
          weeklyRows: weeklyRows.length,
          customRows: customRows.length,
          slotStartISO: data.startsAt,
          slotEndISO: data.endsAt,
          namedWeeklyId: data.availabilityWindowWeeklyId ?? null,
          namedCustomId: data.availabilityWindowCustomId ?? null,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new Error(
        "Selected slot does not fall within the specified availability window",
      );
    }
  } else if (!resolvedProfileId && consultantUserId) {
    resolvedProfileId = (
      await tx.consultantProfile?.findFirst({
        where: { userId: consultantUserId, deletedAt: null },
        select: { id: true },
      })
    )?.id;
  }

  // #1463 — the buyer's own open order for exactly this booking. Resolved once
  // and subtracted from both blocking steps below; see
  // findSelfHoldAppointmentIds for why the exclusion is this narrow.
  const selfHoldAppointmentIds = buyerUserId
    ? await findSelfHoldAppointmentIds(tx, {
        buyerUserId,
        appointmentType: data.appointmentType,
        planId: data.planId,
        paymentGateway: data.paymentGateway,
        organizationId,
        slotStart,
        slotEnd,
        now,
      })
    : [];
  const notSelfHeld: Prisma.AppointmentOccurrenceWhereInput[] =
    selfHoldAppointmentIds.length > 0
      ? [{ NOT: { appointmentId: { in: selfHoldAppointmentIds } } }]
      : [];

  // 1. Check for confirmed overlapping appointments FOR THIS CONSULTANT ONLY
  // FIX Bug #05: Use canonical overlap predicate that catches all 4 overlap shapes
  // (partial start, partial end, full containment, and exact match)
  // FIX #540: Only check slots belonging to occupied (active) appointments.
  // Cancelled/rejected/expired appointment slots should NOT block new bookings.
  // #1688: Also include ACCEPTED co-host commitments on webinars and classes
  // via buildConsultantOccupancyWhere when resolvedProfileId is available.
  const existingBooking = await tx.appointmentOccurrence.findFirst({
    where: {
      AND: [
        { startsAt: { lt: slotEnd } },
        { endsAt: { gt: slotStart } },
        OCCUPYING_OCCURRENCE_WHERE,
        // #1169 PR 2 — the `{ isTentative: false }` filter that used to sit
        // here hid LIVE tentative holds: an in-flight checkout's hold passed
        // unseen (the exclusion constraint carries the same NOT-isTentative
        // predicate), so two overlapping holds both reached payment and both
        // charged. The occupancy term below is the whole check now — it admits
        // live holds and drops released/expired ones by status, and
        // cleanup-tentative-occurrences bounds any stale remainder. Re-adding a
        // confirmed-only predicate here reopens the double-charge.
        ...(resolvedProfileId && consultantUserId
          ? [
              {
                appointment: buildConsultantOccupancyWhere(
                  resolvedProfileId,
                  consultantUserId,
                  now,
                ),
              },
            ]
          : [
              // Filter by consultant — only rows whose booking seats this consultant
              // (#1554: the roster is the appointment's participant list).
              ...(consultantUserId
                ? [
                    {
                      appointment: {
                        participants: {
                          some: {
                            ...liveParticipant(consultantUserId),
                            ...NOT_COLLABORATOR_ROW,
                          },
                        },
                      },
                    },
                  ]
                : []),
              // FIX #540: Only count slots from active/occupied appointments.
              // #1319 — minus dead holds (lapsed DIRECT_CHECKOUT / pay-link windows),
              // so a slot frees the moment its payment window passes rather than
              // when the sweep runs. The JS twin is isOccupiedByLiveAppointment.
              {
                appointment: {
                  AND: [
                    { OR: buildOccupiedAppointmentFilter() },
                    { NOT: buildDeadHoldFilter(now) },
                  ],
                },
              },
            ]),
        // #1463 — the buyer's own live hold on exactly this window and plan is
        // their open order, not another occupant, and the Rec C block below
        // (findReusablePendingOrderPayment) is the path that resumes or
        // supersedes it. Everything else still blocks.
        ...notSelfHeld,
      ],
    },
  });

  if (existingBooking) {
    throw new SlotTakenError();
  }

  // 2. Check for duplicate tentative bookings by the same user FOR THIS CONSULTANT
  // FIX Bug #05: Use canonical overlap predicate
  //
  // #1463 — this step took the caller's ConsulteeProfile id and compared it to
  // `Payment.userId`, which is a User id, so it could never match and the step
  // never fired. The parameter is the buyer's User id now, which is also the
  // identity the self-hold exclusion needs.
  if (buyerUserId) {
    const recentAttempt = await tx.appointmentOccurrence.findFirst({
      where: {
        AND: [
          { startsAt: { lt: slotEnd } },
          { endsAt: { gt: slotStart } },
          { isTentative: true },
          // Filter by consultant — only tentative rows whose booking seats
          // this consultant (#1554).
          ...(consultantUserId
            ? [
                {
                  appointment: {
                    participants: {
                      some: {
                        ...liveParticipant(consultantUserId),
                        ...NOT_COLLABORATOR_ROW,
                      },
                    },
                  },
                },
              ]
            : []),
          {
            appointment: {
              payment: {
                some: buildLiveHoldPaymentFilter(buyerUserId, now),
              },
            },
          },
          // #1463 — same exclusion as step 1: telling the buyer to "complete
          // your current payment" while giving them no way to do so is the
          // dead end this issue is about.
          ...notSelfHeld,
        ],
      },
    });

    if (recentAttempt) {
      throw new Error(
        "You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again.",
      );
    }
  }

  // #1319 — the former "max 3 pending attempts per slot" step is gone: since
  // #1169 PR 2 step 1 blocks on ANY live hold, this count could never reach
  // one, let alone three. Do not re-add a per-slot attempt cap here; the hold
  // itself is the cap.

  return { selfHoldAppointmentIds };
}

/**
 * The invariant: one consultee, one live session per moment of their calendar.
 *
 * The contention key is the consulee's User id plus the requested window, and
 * nothing in the database enforces it. `occurrence_no_confirmed_overlap` is
 * keyed on `consultantProfileId`, so a learner who books two DIFFERENT
 * consultants for the same hour is invisible to the only DB-level backstop in
 * the system. This predicate is therefore load-bearing, and it holds only for
 * as long as it is read inside a transaction that WRITES the window: read in a
 * different, already-committed transaction it closes no race, because the rows
 * it refused on are not the rows the next transaction locks.
 *
 * Occupancy is defined by buildOccupiedAppointmentFilter so the answer matches
 * validateNoConflicts exactly — TENTATIVE and CONFIRMED both block.
 */
export async function assertConsulteeHasNoOverlappingSession(
  tx: Tx,
  window: ConsulteeWindow,
): Promise<void> {
  if (await consulteeHasOverlappingSession(tx, window)) {
    throw consulteeOverlapError();
  }
}

/** The buyer's own calendar is taken at this time: the checkout's existing refusal. */
export function consulteeOverlapError(): Error {
  return new Error("You already have a session booked during this time.");
}

type ConsulteeWindow = {
  userId: string;
  startsAt: string | Date;
  endsAt: string | Date;
  /** #1463 — the buyer's own open order for exactly this window. */
  selfHoldAppointmentIds: string[];
};

/** Whether the buyer already holds a live session overlapping the window (the predicate above). */
export async function consulteeHasOverlappingSession(
  tx: Tx,
  window: ConsulteeWindow,
): Promise<boolean> {
  // An expert buying from another expert is busy on their own calendar too:
  // their hosted sessions and ACCEPTED co-host seats, not only their seats.
  const buyerProfile = await tx.consultantProfile.findUnique({
    where: { userId: window.userId },
    select: { id: true },
  });
  const now = new Date();
  const conflict = await tx.appointment.findFirst({
    where: {
      AND: [
        buyerProfile
          ? buildConsultantOccupancyWhere(buyerProfile.id, window.userId, now)
          : { OR: buildOccupiedAppointmentFilter() },
        // #1319 — parity with step 1 of validateSlotAvailability.
        { NOT: buildDeadHoldFilter(now) },
        // #1463 — the buyer's own open order for this exact window is the thing
        // they are trying to finish paying for, not a competing session on their
        // calendar. Without this the availability fix would only move the wall
        // one query to the right.
        ...(window.selfHoldAppointmentIds.length > 0
          ? [{ NOT: { id: { in: window.selfHoldAppointmentIds } } }]
          : []),
        // userId (User.id) is the right scope — the roster keys on User, not
        // ConsulteeProfile, so this catches conflicts from any org and from
        // marketplace bookings with no org at all.
        ...(buyerProfile
          ? []
          : [
              {
                participants: {
                  some: {
                    ...liveParticipant(window.userId),
                    // A seat whose own payment lapsed no longer holds the buyer's time.
                    NOT: buildDeadSeatFilter(now),
                  },
                },
              },
            ]),
        {
          occurrences: {
            some: {
              AND: [
                { startsAt: { lt: new Date(window.endsAt) } },
                { endsAt: { gt: new Date(window.startsAt) } },
                // The buyer's calendar is arbitrated by the same occurrence
                // rule as the consultant's (buildConsultantOccupancyWhere).
                OCCUPYING_OCCURRENCE_WHERE,
              ],
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  return conflict !== null;
}
