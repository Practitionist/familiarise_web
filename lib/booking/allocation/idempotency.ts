// Replays a double-submitted allocation from the batch its key already
// stamped, and refuses a key reused with a different payload.

import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  AppointmentStatus,
  Prisma,
  AppointmentOccurrence,
} from "@prisma/client";
import {
  AllocationResult,
  EventType,
  isRecurringEventType,
} from "@/utils/scheduling-engine/types";
import {
  intervalStartsOf,
  isDeadOccurrence,
} from "@/lib/appointments/occurrences";
import { sessionsTotalOf } from "@/lib/booking/entitlement";
import { subscriptionUnpaidError } from "@/lib/booking/booking-rule-error";
import { AllocationIdempotencyMismatchError } from "@/utils/scheduling-engine/errors";
import { getEventRelationField } from "@/lib/booking/allocation/identity";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";

/**
 * #837 — idempotent-replay guard for double-submitted allocations. If this
 * batch's key already stamped an appointment, return that batch instead of
 * allocating again. The @unique on Appointment.allocationIdempotencyKey plus
 * the P2002 catch in createAppointments backstop the concurrent (not-yet-
 * committed) race, where two submits both pass this pre-check.
 */
export async function findIdempotentAllocation(
  eventType: EventType,
  eventId: string,
  idempotencyKey?: string,
  /**
   * Manual-mode slot starts (ISO strings) the caller is attempting. When the
   * key already stamped a batch whose live occurrence starts differ, the key
   * was reused with a different payload — a client bug, not a retry — so
   * reject with 422 instead of replaying another request's batch (Stripe's
   * request-hash rule). Omitted for auto/requested: auto slots are
   * server-picked (the client fingerprint already separates intents) and
   * requested approves stored times by definition.
   */
  expectedSlotStarts?: string[],
  /**
   * Pool-1 rule: inside a write transaction this MUST be the caller's tx —
   * a global-client read while the txn holds the single pooled connection
   * waits forever and surfaces as "timeout exceeded when trying to
   * connect" (deploy-preview-only failure; local pools are 10).
   */
  db: PrismaLike = prisma,
): Promise<AllocationResult | null> {
  if (!idempotencyKey) return null;

  const batch = await loadIdempotentBatchAppointments(
    db,
    eventType,
    eventId,
    idempotencyKey,
  );
  if (!batch) return null;

  const { stamped, appointments } = batch;
  if (expectedSlotStarts) {
    assertIdempotentPayloadMatches(
      eventType,
      idempotencyKey,
      stamped.id,
      appointments,
      expectedSlotStarts,
    );
  }

  const outcome = await replayOutcome(eventType, eventId, db);
  return {
    success: true,
    appointments,
    ...(outcome ? { outcome } : {}),
    ...(await replayPartialCounts(eventType, eventId, appointments, db)),
  };
}

/**
 * Where the replayed approval landed, read from the request row: a replay of
 * an approval still awaiting payment must say so, so the caller re-attempts
 * the pay-link mint (idempotent) instead of reporting the times confirmed.
 */
export async function replayOutcome(
  eventType: EventType,
  eventId: string,
  db: PrismaLike = prisma,
): Promise<AllocationResult["outcome"]> {
  const row =
    eventType === "consultation"
      ? await db.consultation.findUnique({
          where: { id: eventId },
          select: { status: true },
        })
      : eventType === "subscription"
        ? await db.subscription.findUnique({
            where: { id: eventId },
            select: { status: true },
          })
        : null;
  if (row?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
    // A plan is paid at purchase and never gets a pay link: answer as a fresh allocation does.
    if (eventType === "subscription") {
      throw subscriptionUnpaidError();
    }
    return "awaiting_payment";
  }
  if (row?.status === AppointmentStatus.APPROVED) return "approved";
  return undefined;
}

export async function loadIdempotentBatchAppointments(
  db: PrismaLike,
  eventType: EventType,
  eventId: string,
  idempotencyKey: string,
): Promise<{
  stamped: { id: string };
  appointments: AppointmentWithSlots[];
} | null> {
  const stamped = await db.appointment.findUnique({
    where: { allocationIdempotencyKey: idempotencyKey },
    select: {
      id: true,
      consultationId: true,
      subscriptionId: true,
      webinarId: true,
      classId: true,
    },
  });
  if (!stamped) return null;

  const relationField = getEventRelationField(eventType);
  const stampedEventId = (stamped as Record<string, string | null>)[
    `${relationField}Id`
  ];
  // Key is globally unique; a mismatch means the client reused it across
  // bookings — a different payload under one key, which is a 422
  // (IDEMPOTENCY_KEY_REUSE), not lock contention: nothing is contended,
  // the key is simply burned for another event.
  if (stampedEventId !== eventId) {
    throw new AllocationIdempotencyMismatchError(
      "This idempotency key was already used for a different allocation.",
    );
  }

  // The key only stamps the FIRST appointment; return the whole batch.
  const appointments = await db.appointment.findMany({
    where: {
      [`${relationField}Id`]: eventId,
    } as Prisma.AppointmentWhereInput,
    include: { occurrences: true },
  });

  return { stamped, appointments };
}

export function startsOfOccurrences(rows: AppointmentOccurrence[]): number[] {
  return rows
    .flatMap((o) => intervalStartsOf(o))
    .map((start) => start.getTime())
    .sort((a, b) => a - b);
}

export function numberArraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function assertIdempotentPayloadMatches(
  eventType: EventType,
  idempotencyKey: string,
  stampedId: string | undefined,
  appointments: AppointmentWithSlots[],
  expectedSlotStarts: string[],
): void {
  // Compared against the batch's live FUTURE rows only: an in-progress
  // recurring manual submit carries future slots while deliberately
  // preserved past rows stay stamped, so testing the whole cohort would
  // 422 a legitimate double-submit instead of replaying it.
  //
  // Expanded to interval starts before comparing: one occurrence covers
  // one whole call with its real end ("the 30-minute intervals stay the
  // unit of arithmetic, not the persisted shape"), while the attempt
  // carries every 30-minute atom — an exact retry of a multi-slot
  // session would otherwise mismatch on row count alone.
  const now = new Date();
  const allLiveOccurrences = appointments
    .flatMap((a) => a.occurrences ?? [])
    .filter((o) => !o.deletedAt && !isDeadOccurrence(o));
  const liveFutureOccurrences = allLiveOccurrences.filter(
    (o) => o.endsAt > now,
  );
  const candidateOccurrences =
    liveFutureOccurrences.length > 0
      ? liveFutureOccurrences
      : allLiveOccurrences;

  const stampedStarts = startsOfOccurrences(liveFutureOccurrences);
  const allStampedStarts = startsOfOccurrences(allLiveOccurrences);
  const attemptedStarts = expectedSlotStarts
    .map((s) => new Date(s).getTime())
    .sort((a, b) => a - b);

  const samePayload =
    numberArraysEqual(stampedStarts, attemptedStarts) ||
    numberArraysEqual(allStampedStarts, attemptedStarts) ||
    matchesRecurringBatchSubset({
      eventType,
      idempotencyKey,
      stampedId,
      appointments,
      candidateOccurrences,
      hasLiveFuture: liveFutureOccurrences.length > 0,
      now,
      attemptedStarts,
    });

  if (!samePayload) {
    throw new AllocationIdempotencyMismatchError(
      "This idempotency key was already used with different slots. " +
        "Reload and submit as a new allocation.",
    );
  }
}

/**
 * #1692 Item 6 — On a multi-batch recurring event (top-up cycle or partial
 * reschedule), the wrapper (or sibling wrappers) also holds pre-existing
 * confirmed future occurrences from earlier cycles. Match against the
 * stamped appointment's occurrences or the latest batch's whole occurrences
 * when multiple recurring occurrences exist.
 */
export function matchesRecurringBatchSubset(params: {
  eventType: EventType;
  idempotencyKey: string;
  stampedId: string | undefined;
  appointments: AppointmentWithSlots[];
  candidateOccurrences: AppointmentOccurrence[];
  hasLiveFuture: boolean;
  now: Date;
  attemptedStarts: number[];
}): boolean {
  const {
    eventType,
    idempotencyKey,
    stampedId,
    appointments,
    candidateOccurrences,
    hasLiveFuture,
    now,
    attemptedStarts,
  } = params;
  if (!isRecurringEventType(eventType) || candidateOccurrences.length <= 1) {
    return false;
  }

  const stampedAppt = appointments.find(
    (a) =>
      (stampedId && a.id === stampedId) ||
      a.allocationIdempotencyKey === idempotencyKey,
  );
  if (stampedAppt && appointments.length > 1) {
    const apptOccurrences = (stampedAppt.occurrences ?? []).filter(
      (o) =>
        !o.deletedAt &&
        !isDeadOccurrence(o) &&
        (!hasLiveFuture || o.endsAt > now),
    );
    if (
      numberArraysEqual(startsOfOccurrences(apptOccurrences), attemptedStarts)
    ) {
      return true;
    }
  }

  const movedRows = candidateOccurrences.filter(
    (o) => ((o as { movedAt?: Date | null }).movedAt ?? null) !== null,
  );
  if (
    movedRows.length > 0 &&
    numberArraysEqual(startsOfOccurrences(movedRows), attemptedStarts)
  ) {
    return true;
  }

  return matchesOrdinalSuffix(candidateOccurrences, attemptedStarts);
}

export function matchesOrdinalSuffix(
  candidateOccurrences: AppointmentOccurrence[],
  attemptedStarts: number[],
): boolean {
  const withOrdinals = candidateOccurrences.filter(
    (o) => typeof (o as { ordinal?: number }).ordinal === "number",
  );
  if (withOrdinals.length !== candidateOccurrences.length) {
    return false;
  }
  const byOrdinal = [...candidateOccurrences].sort(
    (a, b) =>
      ((a as { ordinal?: number }).ordinal ?? 0) -
      ((b as { ordinal?: number }).ordinal ?? 0),
  );
  for (let startIdx = 1; startIdx < byOrdinal.length; startIdx++) {
    const suffixStarts = startsOfOccurrences(byOrdinal.slice(startIdx));
    if (numberArraysEqual(suffixStarts, attemptedStarts)) {
      return true;
    }
  }
  return false;
}

/**
 * #1206 — a replay must not tell the consultee the plan is complete.
 *
 * `allocate()` derives the notification and the consultant's toast from
 * `partial`, so returning the stored batch bare made every double-submit of a
 * partial run read as "all sessions have been automatically scheduled". The
 * counts are re-derived from what is stored — one Appointment per session,
 * against the plan's `totalSessions` — so nothing about the shortfall is
 * persisted here either. Only recurring events can be partial; anything else
 * (and any event whose plan is unreadable) omits the fields and keeps the
 * pre-existing "complete" reading, which is correct for a single session.
 */
export async function replayPartialCounts(
  eventType: EventType,
  eventId: string,
  appointments: {
    deletedAt?: Date | null;
    occurrences?: {
      deletedAt?: Date | null;
      isTentative?: boolean;
      completionStatus?: string;
    }[];
  }[],
  db: PrismaLike = prisma,
): Promise<Partial<AllocationResult>> {
  if (!isRecurringEventType(eventType)) return {};

  // #1766 — a subscription's total is the frozen entitlement, not the plan.
  const subscriptionRow =
    eventType === "subscription"
      ? await db.subscription.findUnique({
          where: { id: eventId },
          select: {
            sessionsTotal: true,
            sessionsRefunded: true,
            subscriptionPlan: { select: { totalSessions: true } },
          },
        })
      : null;
  // A subscription needs the sessions sold less those a support refund removed.
  const requiredSessions =
    eventType === "subscription"
      ? subscriptionRow &&
        sessionsTotalOf(subscriptionRow) - subscriptionRow.sessionsRefunded
      : (
          await db.class.findUnique({
            where: { id: eventId },
            select: { classPlan: { select: { totalSessions: true } } },
          })
        )?.classPlan?.totalSessions;

  if (!requiredSessions || requiredSessions <= 0) return {};

  // #1554 — placed sessions are the wrapper's live confirmed occurrences.
  // Tombstoned or tentative rows are not placed sessions; the returned batch
  // is left as it was so the replay still hands back what the first call did.
  const placedSessions = appointments
    .filter((a) => !a.deletedAt)
    .flatMap((a) => a.occurrences ?? [])
    .filter((o) => !o.isTentative && !isDeadOccurrence(o)).length;
  return {
    partial: placedSessions < requiredSessions,
    placedSessions,
    requiredSessions,
    unplacedSessions: Math.max(0, requiredSessions - placedSessions),
  };
}
