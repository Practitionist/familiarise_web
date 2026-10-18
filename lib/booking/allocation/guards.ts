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

/**
 * Multi-tab guard for `initialAllocation` requests. Auto locks the whole
 * consultant while manual shards by day (#860) — different Redis keys — and
 * group events have no consultee lock, so a cross-mode race from two tabs
 * can slip past the locks; without this the manual path would silently
 * delete-and-replace the winner's allocation. Any confirmed (non-tentative)
 * slot means the event was already allocated elsewhere → typed 409.
 * Called out-of-txn under the locks AND re-checked inside the write txn.
 */
/**
 * In-transaction variant of the guard. Under Read Committed, two
 * concurrent transactions could BOTH count zero confirmed slots before
 * either commits (group events don't share a Redis lock across modes), so
 * the count alone is not atomic. The advisory xact lock serializes the
 * guarded transactions per event: the loser blocks until the winner
 * commits. After the lock, a same-key double submit must REPLAY the
 * winner's committed batch (the base-client read sees it post-commit)
 * rather than trip the guard with a 409; only a different-key submit gets
 * the conflict. Raw SQL is unavoidable — Prisma has no advisory-lock API.
 *
 * #1692 — armed on EVERY allocation transaction, as its first statement,
 * not only on fresh ones: a webinar reschedule from two tabs takes
 * day-sharded Redis keys and used to serialise on nothing, and a same-key
 * retry of a reschedule met the key's unique index as a 409 instead of a
 * replay. Only the confirmed-slot assertion stays gated on `fresh`, since
 * a reschedule legitimately has confirmed slots.
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
 * One read on `AppointmentOccurrence_consultantProfileId_startsAt_endsAt_idx`
 * with the exclusion constraint's own predicate (confirmed, live, this
 * consultant) over the envelope of the proposed slots, minus the event's
 * own rows. A hit is a SLOT_TAKEN 409 nobody has to wait for. A fault in
 * the probe is reported and ignored: it is an optimisation, not a guard.
 */
export async function probeConfirmedOverlap(
  consultantProfileId: string,
  eventType: EventType,
  eventId: string,
  slotStrings: string[],
): Promise<void> {
  const starts = slotStrings
    .map((s) => new Date(s).getTime())
    .filter((t) => !Number.isNaN(t));
  if (starts.length === 0) return;
  const earliest = new Date(Math.min(...starts));
  const latest = new Date(Math.max(...starts) + SCHEDULING_INTERVAL_MS);
  const relationField = getEventRelationField(eventType);
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
        startsAt: { lt: latest },
        endsAt: { gt: earliest },
        appointment: {
          NOT: { [`${relationField}Id`]: eventId },
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
      `Slot taken: ${taken.startsAt.toISOString()} is already booked. Please pick another time.`,
      "SLOT_TAKEN",
    );
  }
}
