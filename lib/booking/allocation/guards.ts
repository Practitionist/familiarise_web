// The allocator's stale-tab and multi-tab preconditions, checked before the
// write transaction and again inside it.

import { reportSentryError } from "@/lib/observability/report";
import prisma, { type Tx, type PrismaLike } from "@/lib/prisma";
import { Prisma, OccurrenceCompletionStatus } from "@prisma/client";
import { AllocationResult, EventType } from "@/utils/scheduling-engine/types";
import {
  liveOccurrenceWhere,
  SCHEDULING_INTERVAL_MS,
} from "@/lib/appointments/occurrences";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import { getEventRelationField } from "@/lib/booking/allocation/identity";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import { tentativeSlotCountOf } from "@/lib/booking/allocation/counts";
import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import { liveParticipant } from "@/lib/booking/participants";

/**
 * The allocation transaction's first statement: an advisory xact lock per
 * event, so every re-check below reads what the previous writer of this event
 * committed. After it a same-key double submit replays the winner's batch
 * instead of tripping a guard; a fresh allocation also asserts that no
 * confirmed slot exists yet (a reschedule legitimately has some). Raw SQL is
 * unavoidable — Prisma has no advisory-lock API.
 */
export async function guardAllocationInTx(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  idempotencyKey: string | undefined,
  fresh: boolean,
  expectedSlotStarts?: string[],
): Promise<AllocationResult | null> {
  // #1518 — `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
  // `void`, and the Prisma 7 driver adapter throws "Failed to deserialize
  // column of type 'void'" on the result row. `$executeRaw` only reads the
  // row count, so nothing is deserialised.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`initial-allocation:${eventType}:${eventId}`}, 42))`;
  const lockedReplay = await findIdempotentAllocation(
    eventType,
    eventId,
    idempotencyKey,
    expectedSlotStarts,
    tx,
  );
  if (lockedReplay) return lockedReplay;
  if (fresh) await assertNoConfirmedSlots(tx, eventType, eventId);
  return null;
}

export async function assertNoConfirmedSlots(
  db: PrismaLike,
  eventType: EventType,
  eventId: string,
): Promise<void> {
  const relationField = getEventRelationField(eventType);
  const confirmed = await db.appointmentOccurrence.count({
    where: {
      // The same predicate assertHeldSessionCountInTx below already used:
      // `isTentative: false` alone counted a CONFIRMED-but-voided row (a
      // cancelled or rescheduled-away session that was not tombstoned) as a
      // live booking, so an event whose sessions had all been released could
      // not be freshly allocated from a dialog.
      ...liveOccurrenceWhere,
      isTentative: false,
      appointment: {
        [`${relationField}Id`]: eventId,
        deletedAt: null,
      } as Prisma.AppointmentWhereInput,
    },
  });
  if (confirmed > 0) {
    throw new AllocationConflictError(
      `This ${eventType} was already allocated in another session ` +
        `(${confirmed} confirmed slot(s) exist).`,
      "ALREADY_ALLOCATED",
    );
  }
}

/**
 * A webinar or class with a live seat is never re-planned: replacing its
 * sessions would move paid attendees with no notice and no free leave. Re-time
 * owns that move. Appending sessions (a top-up) is not a re-plan, so callers
 * skip this for top-ups. Runs after the event's advisory lock.
 */
export async function assertGroupEventUnsoldInTx(
  tx: Tx,
  eventType: EventType,
  eventId: string,
): Promise<void> {
  if (eventType !== "webinar" && eventType !== "class") return;
  const relationField = getEventRelationField(eventType);
  // Buyers only: the host and co-hosts hold participant rows of their own.
  const liveSeats = await tx.appointmentParticipant.count({
    where: {
      ...liveParticipant(),
      role: "CONSULTEE",
      appointment: {
        [`${relationField}Id`]: eventId,
        deletedAt: null,
      } as Prisma.AppointmentWhereInput,
    },
  });
  if (liveSeats > 0) {
    throw new AllocationConflictError(
      `This ${eventType} already has ${liveSeats} booked seat${liveSeats === 1 ? "" : "s"}, ` +
        "so its times can't be re-planned. Use Re-time to move it: attendees are told and may leave with a full refund.",
      "USE_RETIME",
      { liveSeats },
    );
  }
}

/**
 * #1766 — in-txn twin of the cycle arithmetic: the batch size was derived
 * from the held count read outside the transaction, so a second tab that
 * appended in between must 409 rather than pre-schedule the cycle after.
 */
export async function assertHeldSessionCountInTx(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  expected: number,
): Promise<void> {
  const relationField = getEventRelationField(eventType);
  const held = await tx.appointmentOccurrence.count({
    where: {
      ...liveOccurrenceWhere,
      isTentative: false,
      appointment: {
        [`${relationField}Id`]: eventId,
        deletedAt: null,
      } as Prisma.AppointmentWhereInput,
    },
  });
  if (held !== expected) {
    throw new AllocationConflictError(
      `Sessions changed in another session ` +
        `(expected ${expected} held, found ${held}). Reload and try again.`,
      "RESCHEDULE_STATE_CHANGED",
    );
  }
}

/**
 * #1012 — stale-tab reschedule precondition. The page that opened the
 * allocate dialog captured the tentative count; if another tab already
 * finished (or mutated) the reschedule, that count no longer matches and
 * we 409 instead of delete+recreating confirmed slots.
 */
export function assertExpectedTentativeSlotCount(
  actual: number,
  expected: number | undefined,
): void {
  if (expected === undefined) return;
  if (actual !== expected) {
    throw new AllocationConflictError(
      `Reschedule state changed in another session ` +
        `(expected ${expected} tentative slot(s), found ${actual}). ` +
        `Reload and try again.`,
      "RESCHEDULE_STATE_CHANGED",
    );
  }
}

/**
 * #1012 — in-txn re-assert of expectedTentativeSlotCount.
 *
 * The pre-txn read only catches sequential stale submissions. Under the
 * Redis lock another writer can still commit between that read and our
 * write txn (e.g. a second tab that raced the lock, or useRequestedSlots).
 * Re-read with `tx`, behind the per-event advisory lock, before
 * delete/recreate.
 *
 * The count itself is `tentativeSlotCountOf`, the same function the pre-txn
 * read uses. This used to be a third copy of the same reduce, which is how the
 * three came to disagree about what a tentative row is.
 */
export async function assertExpectedTentativeSlotCountInTx(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  expected: number | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const relationField = getEventRelationField(eventType);
  const existingAppointments: AppointmentWithSlots[] =
    await tx.appointment.findMany({
      where: {
        [`${relationField}Id`]: eventId,
      } as Prisma.AppointmentWhereInput,
      include: { occurrences: true },
    });
  assertExpectedTentativeSlotCount(
    tentativeSlotCountOf(existingAppointments),
    expected,
  );
}

/**
 * The picked 30-minute atoms merged into contiguous [start, end) intervals,
 * ascending; unparseable entries are skipped (the mode's parser refuses them).
 */
export function mergeContiguousIntervals(
  slotStrings: readonly string[],
): Array<{ start: Date; end: Date }> {
  const starts = [
    ...new Set(
      slotStrings
        .map((s) => new Date(s).getTime())
        .filter((t) => !Number.isNaN(t)),
    ),
  ].sort((a, b) => a - b);
  const intervals: Array<{ start: number; end: number }> = [];
  for (const start of starts) {
    const last = intervals[intervals.length - 1];
    if (last?.end === start) last.end = start + SCHEDULING_INTERVAL_MS;
    else intervals.push({ start, end: start + SCHEDULING_INTERVAL_MS });
  }
  return intervals.map((i) => ({
    start: new Date(i.start),
    end: new Date(i.end),
  }));
}

/**
 * One read on `AppointmentOccurrence_consultantProfileId_startsAt_endsAt_idx`
 * with the exclusion constraint's own predicate (confirmed, live, this
 * consultant), one OR-arm per picked interval, minus the event's own rows: a
 * session that sits between two picked times is not a conflict. A hit is a
 * SLOT_TAKEN 409 nobody has to wait for. A fault in the probe is reported and
 * ignored: it is an optimisation, not a guard.
 */
export async function probeConfirmedOverlap(
  consultantProfileId: string,
  eventType: EventType,
  eventId: string,
  slotStrings: string[],
): Promise<void> {
  const intervals = mergeContiguousIntervals(slotStrings);
  if (intervals.length === 0) return;
  const relationField = `${getEventRelationField(eventType)}Id`;
  let taken: { startsAt: Date } | null;
  try {
    taken = await prisma.appointmentOccurrence.findFirst({
      where: {
        consultantProfileId,
        isTentative: false,
        deletedAt: null,
        completionStatus: {
          notIn: [
            OccurrenceCompletionStatus.CANCELLED,
            OccurrenceCompletionStatus.RESCHEDULED,
          ],
        },
        OR: intervals.map(({ start, end }) => ({
          startsAt: { lt: end },
          endsAt: { gt: start },
        })),
        // A row of another event type has a NULL relation; `NOT { x: id }`
        // alone would drop it (NULL <> id is not true in SQL).
        appointment: {
          OR: [
            { [relationField]: null },
            { [relationField]: { not: eventId } },
          ],
        } as Prisma.AppointmentWhereInput,
      },
      select: { startsAt: true },
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "bookings",
      op: "probeConfirmedOverlap",
      expected: true,
      level: "warning",
    });
    return;
  }
  if (taken) {
    throw new AllocationConflictError(
      "One of the times you picked is already booked. Pick another time and try again.",
      "SLOT_TAKEN",
      { takenStartsAt: taken.startsAt.toISOString() },
    );
  }
}
