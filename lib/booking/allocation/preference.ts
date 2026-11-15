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
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";

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

  // Placing times answers every other open request on these sessions (they
  // close DECLINED); the proposal this allocation confirms is excluded.
  const superseded = await tx.rescheduleRequest.findMany({
    where: {
      releasedOccurrenceIds: { hasSome: releasedOccurrenceIds },
      status: { in: [...RESCHEDULE_OPEN_STATUSES] },
      ...(excludeRescheduleRequestId
        ? { id: { not: excludeRescheduleRequestId } }
        : {}),
    },
    select: {
      id: true,
      initiatorRole: true,
      appointmentId: true,
      _count: { select: { proposedTimes: true } },
    },
  });
  // The consultant's own proposal waits on the client's consent; placing other
  // times over it would move the booking without asking.
  if (
    superseded.some(
      (r) => r.initiatorRole === "CONSULTANT" && r._count.proposedTimes > 0,
    )
  ) {
    throw new AllocationConflictError(
      "You've asked your client to move to other times. Withdraw that request first, or wait for their answer.",
      "PROPOSAL_AWAITING_CLIENT",
    );
  }
  // The expert's bare release of a paid session is never placed by the expert
  // side: the client accepts proposed times, or the expiry restores the original.
  const bareExpertRelease = superseded.filter(
    (r) => r.initiatorRole === "CONSULTANT" && r._count.proposedTimes === 0,
  );
  if (
    bareExpertRelease.length > 0 &&
    (await tx.payment.count({
      where: {
        appointmentId: { in: bareExpertRelease.map((r) => r.appointmentId) },
        paymentStatus: "SUCCEEDED",
      },
    })) > 0
  ) {
    throw new AllocationConflictError(
      "Propose new times so your client can accept one.",
      "PROPOSE_TIMES_REQUIRED",
    );
  }
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

  const accepted = new Set(consumed.map((r) => r.id));
  for (const request of superseded) {
    if (accepted.has(request.id)) continue;
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
