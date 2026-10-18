// The consultee's stated placement preference for a reschedule, and closing
// the requests an allocation answered.

import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { AllocationPreference } from "@/utils/scheduling-engine/preferenceScoring";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/** Open, preference-bearing reschedules that released any of these slots. */
export function openPreferenceRequestWhere(
  releasedOccurrenceIds: string[],
): Prisma.RescheduleRequestWhereInput {
  return {
    releasedOccurrenceIds: { hasSome: releasedOccurrenceIds },
    status: { in: RESCHEDULE_OPEN_STATUSES },
    OR: [
      { preferredTimeOfDay: { not: null } },
      { preferredDays: { not: null } },
    ],
  };
}

/**
 * The preference attached to the reschedule that released these slots, if the
 * initiator stated one (#1065).
 *
 * Read here rather than passed in because the allocator is reached from the
 * consultant's allocate surface, the auto-confirm path and the API route
 * alike — none of which know what the consultee asked for. Empty for every
 * non-reschedule allocation, which is exactly when it must not apply.
 *
 * Matching on the released slots also scopes it in TIME without needing a
 * timestamp: a consumed reschedule's slot rows are deleted and replaced with
 * fresh ids, so a stale row from an earlier reschedule of the same session
 * cannot overlap this one and cannot leak its preference into it.
 */
export async function findAllocationPreference(
  releasedOccurrenceIds: string[],
): Promise<AllocationPreference | undefined> {
  if (releasedOccurrenceIds.length === 0) return undefined;

  const stated = await prisma.rescheduleRequest.findFirst({
    where: openPreferenceRequestWhere(releasedOccurrenceIds),
    // Newest wins; an older ask must not outrank the current one.
    orderBy: { createdAt: "desc" },
    select: { preferredTimeOfDay: true, preferredDays: true },
  });

  return stated ?? undefined;
}

/**
 * Close the preference-only reschedule this allocation just answered.
 *
 * Placing replacement times IS the answer to "move these, ideally mornings",
 * so leaving the row PENDING_REVIEW would both mislabel it in the audit trail
 * — it was fulfilled, not lapsed unanswered — and keep its
 * openForAppointmentId reservation held until the hourly expiry sweep, which
 * would block the consultee from rescheduling the same booking again for up
 * to 72 hours.
 *
 * Deliberately scoped to rows carrying NO proposed times. A request that
 * named times and got different ones back has not been accepted, and how that
 * case resolves is existing behaviour (it lapses to EXPIRED) that this change
 * has no business rewriting.
 *
 * resolvedById is left null: the allocator is reached from routes, crons and
 * the auto-confirm path, and inventing an actor here would be worse than
 * recording none.
 *
 * @param excludeRescheduleRequestId #1340 — the proposal this allocation is
 * confirming, which must survive the supersede sweep below so its caller can
 * close it as AUTO_ACCEPTED/ACCEPTED.
 */
export async function resolveConsumedPreferenceRequests(
  tx: Tx,
  releasedOccurrenceIds: string[],
  excludeRescheduleRequestId?: string,
): Promise<void> {
  if (releasedOccurrenceIds.length === 0) return;

  const consumed = await tx.rescheduleRequest.findMany({
    where: {
      ...openPreferenceRequestWhere(releasedOccurrenceIds),
      proposedTimes: { none: {} },
    },
    select: { id: true },
  });

  for (const request of consumed) {
    try {
      // The shared transition helper rather than a bare update: reaching a
      // terminal state is what releases openForAppointmentId and stamps
      // resolvedAt, and callers must not have to remember that.
      await transitionRescheduleRequest(tx, {
        where: { id: request.id },
        to: "ACCEPTED",
      });
    } catch (err) {
      // Losing the CAS means the initiator withdrew (or the sweep expired the
      // row) between the read above and here. That is a perfectly good ending
      // for the request and no reason to roll back an allocation that has
      // already placed real times — closing the row is bookkeeping, the
      // booking is the outcome.
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }

  // E2E-audit P1 fix — times-bearing proposals must not dangle when the
  // consultant answers a concrete-times proposal by placing DIFFERENT times
  // directly on the calendar grid. The proposal used to stay PENDING_REVIEW
  // for up to its 72h lifetime with openForAppointmentId reserved — and a
  // stale Accept still passed every guard, re-ran the allocator at the
  // originally proposed times, and silently deleted the just-placed
  // confirmed slots. The manual placement IS the answer: close these as
  // DECLINED so the reschedule machine releases the reservation.
  //
  // #1340 — "superseded" means every OTHER open proposal. A confirmation
  // (auto-confirm or an explicit accept) places the proposal's OWN times, so
  // without this exclusion the sweep declined the very row its caller was
  // about to close as AUTO_ACCEPTED/ACCEPTED: the CAS matched zero rows, the
  // booking moved, and the paperwork said the consultee's request had been
  // refused.
  const superseded = await tx.rescheduleRequest.findMany({
    where: {
      releasedOccurrenceIds: { hasSome: releasedOccurrenceIds },
      status: { in: [...RESCHEDULE_OPEN_STATUSES] },
      ...(excludeRescheduleRequestId
        ? { id: { not: excludeRescheduleRequestId } }
        : {}),
    },
    select: { id: true },
  });
  for (const request of superseded) {
    try {
      await transitionRescheduleRequest(tx, {
        where: { id: request.id },
        to: "DECLINED",
      });
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
}
