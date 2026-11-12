// Writes the allocation's occurrences onto the event's purchase wrapper,
// seats its participants, and debits a subscription's cap.

import { recordParticipants } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { EventType, EventConfig } from "@/utils/scheduling-engine/types";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import {
  nextOrdinal,
  SCHEDULING_INTERVAL_MS,
} from "@/lib/appointments/occurrences";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { isHostMove, type FreedWindow } from "@/lib/booking/class-series";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import {
  getEventRelationField,
  getAppointmentType,
} from "@/lib/booking/allocation/identity";
import { recordSubscriptionAllocationCap } from "@/lib/booking/allocation/commit/subscription-cap";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import type { PendingOverageNotification } from "@/lib/payments/billing/overage-settlement";

/**
 * Create the occurrence rows for allocated slots (#1554).
 *
 * ARCHITECTURE:
 * - One Appointment = one PURCHASE (the wrapper checkout or the planner
 *   created); a subscription or class is one wrapper with N occurrences.
 * - One AppointmentOccurrence = one call, carrying its real endsAt and a
 *   1-based ordinal inside the wrapper.
 * - The 30-minute interval is the unit of arithmetic only.
 *
 * The wrapper is REUSED whenever it exists (the payment-bearing row for a
 * subscription, the class row the planner minted, a preserved 1:1 row); a
 * fresh wrapper is created only when the event has none. Returns the one
 * wrapper in a single-element array, which is what every caller reads, and a
 * subscription's member-due overage notice to send after commit.
 *
 * DEFENSIVE VALIDATION:
 * This is a defensive check - slot count should already be validated
 * by the caller, but we verify again to prevent data corruption.
 */
export async function createAppointments(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  slots: Date[],
  consultantUserId: string,
  consulteeUserId?: string,
  config?: EventConfig,
  // #768 Comment 5 — slots created here inherit the org context
  // resolved by fetchEventData. SUBSCRIPTION pulls from the placeholder
  // Appointment's Payment.organizationId; CLASS pulls from
  // classPlan.organizationId (host wins per #768 design decision);
  // CONSULTATION/WEBINAR re-read the existing Appointment's tag.
  organizationId?: string | null,
  // #898 — when set (a 1:1 consultation/webinar whose payment-bearing
  // appointment was preserved by the delete guard), REUSE that appointment
  // instead of creating a second row on the @unique event FK (P2002). Only
  // ever set for single-call event types.
  reuseAppointmentId?: string,
  // #837 — stamp this batch's dedupe key on the FIRST appointment only, so a
  // replay trips the @unique (P2002 → typed 409 below) if it slips past the
  // pre-check. Nullable by design: only real keys dedupe.
  idempotencyKey?: string,
  // #1554 — ordinals of the rows this allocation replaces, in call order;
  // call i inherits position i and only surplus calls take a new number.
  inheritedOrdinals: number[] = [],
  // #1780 decision 9 — a reschedule's replacements are moves; a re-plan's
  // row is a move only when its times differ from the freed row's.
  moves?: { isReschedule: boolean; freedWindows: FreedWindow[] },
): Promise<{
  appointments: AppointmentWithSlots[];
  overageNotice: PendingOverageNotification | null;
}> {
  const hostMoves = moves ?? { isReschedule: false, freedWindows: [] };
  const slotsPerCall = ScheduleCalculationService.getSlotsPerCall(
    config?.sessionDurationInHours || config?.durationInHours || 1,
  );

  // DEFENSIVE CHECK: Ensure slots divide evenly into complete appointments
  // This should never fail if validation was done correctly, but prevents
  // database corruption if validation was bypassed
  if (slots.length % slotsPerCall !== 0) {
    throw new Error(
      `INTERNAL ERROR: Cannot create appointments - ${slots.length} slots ` +
        `cannot be evenly divided into ${slotsPerCall}-slot sessions. ` +
        `This indicates a validation bug.`,
    );
  }

  // Group slots by call (consecutive blocks)
  const calls: Date[][] = [];
  for (let i = 0; i < slots.length; i += slotsPerCall) {
    calls.push(slots.slice(i, i + slotsPerCall));
  }

  // CRITICAL: For consultations/webinars, ensure only ONE appointment is created
  if (
    (eventType === "consultation" || eventType === "webinar") &&
    calls.length > 1
  ) {
    throw new Error(
      `INTERNAL ERROR: ${eventType} should create exactly 1 appointment, but ${calls.length} were grouped. ` +
        `This indicates non-consecutive slots were provided. Slots: ${slots.map((s) => s.toISOString()).join(", ")}`,
    );
  }

  // #440 — denormalize the consultant onto each slot for the DB-level
  // overlap guard. The column is nullable for LEGACY rows only — an active
  // allocation without a resolvable profile would silently disable the
  // guard, so it throws instead (review catch on #843).
  const consultantProfileRow = await tx.consultantProfile.findFirst({
    where: { user: { id: consultantUserId } },
    select: { id: true },
  });
  if (!consultantProfileRow) {
    throw new Error(
      `Consultant profile not found for user ${consultantUserId} — refusing to create slots without the #440 overlap-guard column`,
    );
  }

  // #1499 — sessions allocated later inherit the terms the booking was SOLD
  // under, read off the row checkout created (the oldest appointment of this
  // event). Resolving fresh here would hand a buyer whatever ladder the org
  // published since, which is precisely what versioning exists to prevent. A
  // reused appointment already carries its own FK, so it is skipped.
  let inheritedPolicyId: string | null = null;
  if (!reuseAppointmentId) {
    const relationField = getEventRelationField(eventType);
    const originating = await tx.appointment.findFirst({
      where: {
        [`${relationField}Id`]: eventId,
      } as Prisma.AppointmentWhereInput,
      orderBy: { createdAt: "asc" },
      select: { cancellationPolicyId: true },
    });
    inheritedPolicyId = originating?.cancellationPolicyId ?? null;
  }

  // One wrapper, N occurrences. A concurrent booking that overlaps an
  // existing confirmed occurrence trips the #440 exclusion constraint (or the
  // unique guard); convert it to a typed 409 here at the source so
  // classifyError can stay typed-only rather than sniffing Postgres error
  // strings (#837).
  let appointments: AppointmentWithSlots[];
  // The rows THIS batch wrote, by ordinal: a reused wrapper's include also
  // returns the occurrences it already had (#1554).
  let newOccurrenceIds: string[] = [];
  try {
    const relationField = getEventRelationField(eventType);
    // #1554 — the purchase wrapper already exists for every subscription
    // (checkout minted it) and for a class the planner scheduled; attach to
    // it. The event FKs are @unique, so a second create would be a P2002.
    const wrapperId =
      reuseAppointmentId ??
      (
        await tx.appointment.findFirst({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          select: { id: true },
        })
      )?.id;
    // A genuinely new call continues the wrapper's numbering past both the
    // surviving rows and the positions being inherited.
    let nextFreshOrdinal = Math.max(
      wrapperId ? await nextOrdinal(tx, wrapperId) : 1,
      ...inheritedOrdinals.map((ordinal) => ordinal + 1),
    );
    // #837 — the batch's dedupe key rides on the wrapper.
    const idempotencyData = idempotencyKey
      ? { allocationIdempotencyKey: idempotencyKey }
      : {};
    // One occurrence per call with the real end; the 30-minute intervals
    // stay the unit of arithmetic, not the persisted shape.
    const movedAt = new Date();
    const occurrencesToCreate = calls.map((sessionSlots, callIndex) => {
      const row = {
        ordinal: inheritedOrdinals[callIndex] ?? nextFreshOrdinal++,
        startsAt: sessionSlots[0],
        endsAt: new Date(
          sessionSlots[sessionSlots.length - 1].getTime() +
            SCHEDULING_INTERVAL_MS,
        ),
        isTentative: false,
        consultantProfileId: consultantProfileRow.id,
      };
      const inherited = inheritedOrdinals[callIndex] !== undefined;
      return inherited && isHostMove(row, hostMoves)
        ? { ...row, movedAt }
        : row;
    });

    // A reused wrapper keeps the key its first batch stamped, so a retry of
    // that batch still replays; a later batch stamps only a wrapper with none.
    if (wrapperId && idempotencyKey) {
      await tx.appointment.updateMany({
        where: { id: wrapperId, allocationIdempotencyKey: null },
        data: { allocationIdempotencyKey: idempotencyKey },
      });
    }
    const wrapper = wrapperId
      ? await tx.appointment.update({
          where: { id: wrapperId },
          data: { occurrences: { create: occurrencesToCreate } },
          include: { occurrences: true },
        })
      : await tx.appointment.create({
          // Unchecked (scalar-FK) shape throughout, as checkout writes it.
          // A relation-style `connect` next to any scalar FK makes Prisma
          // validate against the checked input, which has no *Id fields —
          // "Unknown argument cancellationPolicyId" (FAMILIARISE_WEB-4F).
          data: {
            appointmentType: getAppointmentType(eventType),
            [`${relationField}Id`]: eventId,
            ...idempotencyData,
            organizationId: organizationId ?? null,
            // B1/#1499 — inherit the terms the booking was sold under;
            // NULL is the platform ladder.
            cancellationPolicyId: inheritedPolicyId,
            occurrences: { create: occurrencesToCreate },
          },
          include: { occurrences: true },
        });
    appointments = [wrapper];
    // #1569 — the hold anchors on the last live call, and this write just
    // changed the live set (first allocation, top-up or reschedule alike).
    await recomputeEarningsHold(tx, wrapper.id);
    const written = new Set(occurrencesToCreate.map((row) => row.ordinal));
    newOccurrenceIds = (
      wrapper.occurrences as { id: string; ordinal: number }[]
    )
      .filter((row) => written.has(row.ordinal))
      .map((row) => row.id);
    // #1319 A9 — allocation writes confirmed occurrences, so the participants
    // are CONFIRMED from the start; a reused wrapper already has its rows
    // (createMany skips duplicates). Once per purchase (#1554).
    await recordParticipants(
      tx,
      wrapper.id,
      consulteeUserId
        ? [
            { userId: consultantUserId, role: "CONSULTANT" },
            { userId: consulteeUserId, role: "CONSULTEE" },
          ]
        : [{ userId: consultantUserId, role: "CONSULTANT" }],
      { organizationId: organizationId ?? null, status: "CONFIRMED" },
    );
  } catch (error) {
    // Not captured here — createAppointments only runs inside
    // autoAllocate/manualAllocate, both under allocate()'s try, whose catch
    // reports every error reaching it (this one included). A second
    // capture here would be a pure dupe of the same instance.
    // Classified by constraint: the overlap guard is someone else getting the
    // time first; a live-ordinal clash is a concurrent allocation of this
    // event that already placed its sessions. The idempotency key's clash
    // propagates raw so allocate() replays the winner; any other constraint
    // is a fault.
    if (isExclusionViolation(error)) {
      throw new AllocationConflictError(
        "One of these times was just booked. Pick another time and try again.",
        "SLOT_TAKEN",
      );
    }
    if (isUniqueViolationOn(error, "ordinal")) {
      throw new AllocationConflictError(
        "This booking was just scheduled in another tab. Reload to see its sessions.",
        "ALREADY_ALLOCATED",
      );
    }
    throw error;
  }

  // Issue #710: per-allocation cap debit for SUBSCRIPTION.
  //
  // CONSULTATION/WEBINAR debit at checkout (1 engagement, slots known
  // synchronously). CLASS debits at enrolment (N engagements, all
  // occurrences pre-allocated by the consultant). SUBSCRIPTION is the
  // only event type with truly lazy allocation — the consultant adds calls
  // one-at-a-time via the Requests tab — so the cap debit must happen
  // here, once per occurrence created (#1554: the engagement is the call).
  //
  // The original Payment carries the org tag; we re-resolve the
  // ProgramAssignment fresh because cycles may have rolled since
  // signup and we want today's cap, not signup-time's cap. If the
  // booking wasn't org-sponsored (no organizationId on the original
  // Payment) we skip silently.
  const overageNotice =
    eventType === "subscription" &&
    consulteeUserId &&
    newOccurrenceIds.length > 0
      ? await recordSubscriptionAllocationCap(
          tx,
          eventId,
          consulteeUserId,
          newOccurrenceIds,
        )
      : null;

  return { appointments, overageNotice };
}
