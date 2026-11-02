// Frees the rows a re-plan replaces. A Payment-bearing appointment is never
// deleted: the payment guard rides in each delete's own WHERE.

import { liveParticipant } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  EventType,
  isReleasedForReschedule,
} from "@/utils/scheduling-engine/types";
import type { FreedWindow } from "@/lib/booking/class-series";
import { TWENTY_FOUR_HOURS_IN_MS } from "@/utils/scheduling-engine/slotTimeUtils";
import { getEventRelationField } from "@/lib/booking/allocation/identity";
import { isVoidRequestRow } from "@/lib/booking/allocation/counts";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";

/**
 * Delete existing appointments for an event
 *
 * @param onlyTentative - If true, only delete RELEASED AppointmentOccurrence records
 *                        (tentative + RESCHEDULED + live), preserving confirmed slots,
 *                        fresh tentative holds and their parent appointments.
 *                        Appointments are only deleted if they have zero remaining slots
 *                        after released-slot removal. This is used for partial reschedules.
 * @param preservePastSlots - If true (and onlyTentative is false), only delete future slots,
 *                            preserving past confirmed slots and their Meeting records.
 *                            Used for in-progress reallocation of classes/subscriptions.
 * @returns preservedSlotCount - Number of past slots that were preserved.
 * @returns enrolledUserIds - User IDs connected to deleted future slots (for reconnection).
 * @returns deletedAppointmentIds - AE-4: appointment ids whose tentative slots
 *   were freed (partial reschedule path), so callers can refresh those slots.
 * @returns freedOrdinals - #1554: the ordinals of the occurrence rows this
 *   call deleted, in start order, so their replacements inherit them.
 */
export async function deleteExistingAppointments(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  onlyTentative: boolean = false,
  preservePastSlots: boolean = false,
): Promise<{
  preservedSlotCount: number;
  enrolledUserIds: string[];
  deletedAppointmentIds: string[];
  freedOrdinals: number[];
  freedWindows: FreedWindow[];
  // #898 — id of a preserved 1:1 (consultation/webinar) payment-bearing
  // appointment the caller must REUSE: its @unique event FK is still taken,
  // so a fresh create would throw P2002. At most one per 1:1 event.
  reusableAppointmentId?: string;
}> {
  const relationField = getEventRelationField(eventType);
  const whereClause = {
    [`${relationField}Id`]: eventId,
  } as Prisma.AppointmentWhereInput;
  // #898 — set in the onlyTentative / full-delete branches when a 1:1
  // payment-bearing appointment is kept rather than deleted.
  let reusableAppointmentId: string | undefined;

  if (onlyTentative) {
    // Find appointments with tentative slots for this event
    const appointments = await tx.appointment.findMany({
      where: whereClause,
      include: {
        // #1554 — live seat holders, so enrolled learners on a group event
        // can be re-seated on the replacement appointments.
        participants: { where: liveParticipant(), select: { userId: true } },
        occurrences: true,
        // B8 — Payment has onDelete: Cascade on Appointment; deleting an
        // appointment with payment rows destroys the payment/refund audit
        // trail. The refusal now rides in the delete's own WHERE clause
        // (B-P1-05) rather than this read, which can go stale mid-txn.
      },
    });

    // AE-4 — record which appointments had tentative slots freed here (ids
    // captured from the pre-fetched rows, before the deleteMany runs).
    const deletedAppointmentIds: string[] = [];
    // Capture the seat holders of the appointments being emptied. For a
    // group event (class) the enrolled learners live ONLY on
    // AppointmentParticipant — createAppointments seats just the
    // consultant, so without this they'd be orphaned when the class is
    // scheduled (tentative crud-with-plan slots → onlyTentative path).
    // reconnectEnrolledUsers re-seats them; it filters the consultant itself.
    const enrolledUserIdSet = new Set<string>();
    const freed: { ordinal: number; startsAt: Date; endsAt: Date }[] = [];
    for (const appointment of appointments) {
      // Released rows only: a reschedule frees what it released, never a
      // fresh request's tentative holds or crud-with-plan placeholders that
      // happen to coexist on the same event.
      const released = appointment.occurrences.filter(isReleasedForReschedule);
      const hasTentative = released.length > 0;

      if (hasTentative) {
        deletedAppointmentIds.push(appointment.id);
        for (const slot of released) {
          freed.push(slot);
        }
        // Collect the seat holders before the appointment may be deleted
        // (their participant rows cascade with it).
        for (const seat of appointment.participants) {
          enrolledUserIdSet.add(seat.userId);
        }
        // Delete only released slots using a direct query (not stale IDs).
        // The WHERE mirrors isReleasedForReschedule: tentative +
        // RESCHEDULED + live.
        await tx.appointmentOccurrence.deleteMany({
          where: {
            appointmentId: appointment.id,
            isTentative: true,
            completionStatus: "RESCHEDULED",
            deletedAt: null,
          },
        });

        // If no occurrences remain after the released ones are removed,
        // delete the now-empty appointment — unless payments reference it
        // (B8): the empty shell is cheaper than a destroyed audit trail;
        // the orphan sweep reports it. A surviving fresh hold or confirmed
        // slot keeps the wrapper: deleting it would cascade-destroy rows
        // this reschedule did not release.
        //
        // B-P1-05 (#1189 audit) — the payment guard rides IN the delete's
        // WHERE clause rather than trusting `_count.payment` above. That
        // count was read earlier in this transaction; a checkout's Payment
        // insert can COMMIT between the read and the delete, and
        // Payment.appointment is onDelete: Cascade, so an unconditional
        // delete would cascade-destroy a payment that did not exist when we
        // looked. Zero rows deleted means a payment appeared: keep the
        // appointment exactly like the payment-bearing path.
        const hasRemaining = appointment.occurrences.some(
          (slot) => !isReleasedForReschedule(slot),
        );
        const deletedAppointment = !hasRemaining
          ? await tx.appointment.deleteMany({
              where: { id: appointment.id, payment: { none: {} } },
            })
          : null;
        if (
          (hasRemaining || deletedAppointment?.count === 0) &&
          (eventType === "consultation" || eventType === "webinar")
        ) {
          // #898 — the appointment is kept (unreleased slots remain, or the
          // payment guard fired). For a 1:1 event it still holds the @unique
          // event FK, so the allocator must REUSE it; a fresh create P2002s.
          reusableAppointmentId = appointment.id;
        }
      }
    }
    return {
      preservedSlotCount: 0,
      enrolledUserIds: Array.from(enrolledUserIdSet),
      deletedAppointmentIds,
      freedOrdinals: ordinalsInStartOrder(freed),
      freedWindows: windowsOf(freed),
      reusableAppointmentId,
    };
  } else if (preservePastSlots) {
    // In-progress reallocation: only delete future slots, preserve past ones
    const now = new Date();
    const appointments = await tx.appointment.findMany({
      where: whereClause,
      include: {
        // #1554 — live seat holders, so enrolled learners on a group event
        // can be re-seated on the replacement appointments.
        participants: { where: liveParticipant(), select: { userId: true } },
        occurrences: {
          include: {
            meeting: { select: { id: true, endedAt: true } },
          },
        },
        // The payment guard on the empty-appointment delete below rides in
        // that delete's WHERE clause (B-P1-05), not in a pre-read count.
      },
    });

    let preservedSlotCount = 0;
    const enrolledUserIdSet = new Set<string>();
    const freed: { ordinal: number; startsAt: Date; endsAt: Date }[] = [];
    const imminentCutoff = new Date(now.getTime() + TWENTY_FOUR_HOURS_IN_MS);

    for (const appointment of appointments) {
      const pastSlots = appointment.occurrences.filter(
        (slot) => new Date(slot.endsAt) <= now,
      );
      const futureSlots = appointment.occurrences.filter(
        (slot) => new Date(slot.endsAt) > now,
      );

      // Guard: preserve slots that are imminent (<24h) or have active sessions
      const protectedFutureSlots = futureSlots.filter(
        (slot) =>
          new Date(slot.startsAt) < imminentCutoff ||
          (slot.meeting && !slot.meeting.endedAt),
      );
      const deletableFutureSlots = futureSlots.filter(
        (slot) =>
          new Date(slot.startsAt) >= imminentCutoff &&
          (!slot.meeting || slot.meeting.endedAt !== null),
      );

      preservedSlotCount += pastSlots.length + protectedFutureSlots.length;

      // Capture the seat holders before the appointment may be deleted
      if (deletableFutureSlots.length > 0) {
        for (const seat of appointment.participants) {
          enrolledUserIdSet.add(seat.userId);
        }
      }

      if (deletableFutureSlots.length > 0) {
        freed.push(...deletableFutureSlots);
        await tx.appointmentOccurrence.deleteMany({
          where: {
            appointmentId: appointment.id,
            id: { in: deletableFutureSlots.map((s) => s.id) },
          },
        });
      }

      // Only delete the appointment if no slots remain at all — and never
      // when it carries payments (#898 defense-in-depth: the Payment cascade
      // is Restrict-blocked by ConsultantEarnings and rolls back the tx).
      // Latent today (the subscription placeholder can't reach this branch),
      // but mirrors the onlyTentative / full-delete guards. The payment
      // guard rides in the delete's WHERE (B-P1-05) — same race as the
      // onlyTentative branch.
      if (pastSlots.length === 0 && protectedFutureSlots.length === 0) {
        await tx.appointment.deleteMany({
          where: { id: appointment.id, payment: { none: {} } },
        });
      }
    }

    return {
      preservedSlotCount,
      enrolledUserIds: Array.from(enrolledUserIdSet),
      // AE-4 — in-progress path frees future slots, not tentative ones; the
      // freed-id contract is scoped to the partial-reschedule case.
      deletedAppointmentIds: [],
      freedOrdinals: ordinalsInStartOrder(freed),
      freedWindows: windowsOf(freed),
      // #898 — only class/subscription (1:N) reach this branch; no 1:1 reuse.
      reusableAppointmentId,
    };
  } else {
    // Full delete: remove all appointments for this event.
    // B8 — an appointment that carries Payment rows must NOT be deleted: the
    // delete cascades to Payment (onDelete: Cascade), which is Restrict-
    // referenced by ConsultantEarnings, so the cascade trips the
    // ConsultantEarnings_paymentId_fkey constraint and the whole allocation
    // rolls back. This is exactly the SUBSCRIPTION case — checkout leaves a
    // zero-slot placeholder Appointment carrying the signup Payment+earnings,
    // and initial allocation reaches this branch. Mirror the onlyTentative
    // guard: preserve payment-bearing appointments, just free their slots so
    // they no longer block availability; delete the rest as before.
    const existingAppointments = await tx.appointment.findMany({
      where: whereClause,
      include: {
        // #1554 — live seat holders, so enrolled learners on a group event
        // can be re-seated on the replacement appointments.
        participants: { where: liveParticipant(), select: { userId: true } },
        // meeting rides along so held-session slots can be preserved
        // (#1169 PR 1 — deleting them cascades Meeting → Recording).
        occurrences: {
          include: {
            meeting: { select: { id: true } },
            // An incident remedy cascades with its session; such a row is
            // never deleted (see the refusal below).
            _count: { select: { incidentRemedies: true } },
          },
        },
        _count: { select: { payment: true } },
      },
    });

    // Capture every seat holder before the appointment is deleted or
    // stripped; reconnectEnrolledUsers (called by the allocator on a non-empty
    // result) re-seats them on the new appointments and filters the consultant.
    const enrolledUserIdSet = new Set<string>();
    for (const appointment of existingAppointments) {
      for (const seat of appointment.participants) {
        enrolledUserIdSet.add(seat.userId);
      }
    }
    // Every replaceable sessionless row below is deleted whichever arm runs;
    // a held-session or completed/past history row survives and keeps its ordinal.
    const now = new Date();
    const isProtectedSessionlessSlot = (
      slot: (typeof existingAppointments)[number]["occurrences"][number],
    ): boolean =>
      slot.completionStatus === "COMPLETED" ||
      (slot.completionStatus !== undefined &&
        !slot.isTentative &&
        new Date(slot.endsAt) <= now);
    // Tombstoned and cancelled rows hold no time; they are history the
    // re-plan keeps, never rows it deletes or frees.
    const isReplaceable = (
      slot: (typeof existingAppointments)[number]["occurrences"][number],
    ): boolean =>
      slot.meeting === null &&
      !isProtectedSessionlessSlot(slot) &&
      !isVoidRequestRow(slot);
    const freed = existingAppointments.flatMap((appointment) =>
      appointment.occurrences.filter(isReplaceable),
    );
    // Until the busy-time ledger replaces this hard delete: a session that
    // carries an incident remedy is never deleted under it.
    if (freed.some((slot) => (slot._count?.incidentRemedies ?? 0) > 0)) {
      throw new AllocationConflictError(
        "A session in this booking has a platform-incident remedy attached. Settle the remedy before re-planning these sessions.",
        "SESSION_HAS_REMEDY",
      );
    }

    await Promise.all(
      existingAppointments.map(async (appointment) => {
        // #1169 PR 1 & #1692 Item 6 — a slot whose Meeting already happened
        // or that is already COMPLETED / in the past is history, not
        // availability: deleting it cascades Meeting → Recording or destroys
        // completed occurrence history. Preserve the appointment and every
        // held/completed/past slot; only replaceable future sessionless slots
        // are freed.
        const hasHeldSession = appointment.occurrences.some(
          (slot) => slot.meeting !== null,
        );
        const hasProtectedSessionless = appointment.occurrences.some(
          isProtectedSessionlessSlot,
        );
        const hasVoidHistory = appointment.occurrences.some(isVoidRequestRow);
        const occurrenceDeleteWhere: Prisma.AppointmentOccurrenceWhereInput =
          hasProtectedSessionless
            ? {
                appointmentId: appointment.id,
                meeting: { is: null },
                deletedAt: null,
                endsAt: { gt: now },
                completionStatus: { notIn: ["COMPLETED", "CANCELLED"] },
              }
            : {
                appointmentId: appointment.id,
                meeting: { is: null },
                deletedAt: null,
                completionStatus: { not: "CANCELLED" },
              };
        if (
          (appointment._count?.payment ?? 0) > 0 ||
          hasHeldSession ||
          hasProtectedSessionless ||
          hasVoidHistory
        ) {
          // Keep the Appointment (and its Payment + ConsultantEarnings audit
          // trail); strip its slots. No-op for the slot-less subscription
          // placeholder, but frees slots for any other payment-bearing case.
          if (eventType === "consultation" || eventType === "webinar") {
            // #898 — 1:1 event: the kept appointment still holds the @unique
            // event FK, so the allocator must REUSE it (a fresh create P2002s).
            // At most one such appointment exists per 1:1 event.
            reusableAppointmentId = appointment.id;
          }
          return tx.appointmentOccurrence.deleteMany({
            where: occurrenceDeleteWhere,
          });
        }
        // B-P1-05 (#1189 audit) — atomic payment guard, same as the
        // onlyTentative branch: a checkout's Payment can commit between the
        // `_count` read above and this delete; the WHERE clause re-checks at
        // write time so the cascade can never consume it. Zero rows deleted
        // means a payment appeared — keep the appointment and strip only its
        // sessionless slots, exactly like the payment-bearing path above.
        const deletedAppointment = await tx.appointment.deleteMany({
          where: { id: appointment.id, payment: { none: {} } },
        });
        if (deletedAppointment.count === 0) {
          if (eventType === "consultation" || eventType === "webinar") {
            reusableAppointmentId = appointment.id;
          }
          return tx.appointmentOccurrence.deleteMany({
            where: occurrenceDeleteWhere,
          });
        }
        return deletedAppointment;
      }),
    );
    return {
      preservedSlotCount: 0,
      enrolledUserIds: Array.from(enrolledUserIdSet),
      deletedAppointmentIds: [],
      freedOrdinals: ordinalsInStartOrder(freed),
      freedWindows: windowsOf(freed),
      reusableAppointmentId,
    };
  }
}

/** #1780 decision 9 — the times each freed ordinal held before the re-plan. */
export function windowsOf(
  rows: { ordinal: number; startsAt: Date; endsAt: Date }[],
): FreedWindow[] {
  return rows.map((row) => ({
    ordinal: row.ordinal,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
}

/** #1554 — freed ordinals in call order, so call i inherits position i. */
export function ordinalsInStartOrder(
  rows: { ordinal: number; startsAt: Date }[],
): number[] {
  return [...rows]
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    )
    .map((row) => row.ordinal);
}
