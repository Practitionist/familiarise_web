/**
 * Reschedule proposals — the policy layer.
 *
 * Rescheduling used to carry LESS information than the original booking: the
 * API accepted only which slots to RELEASE, so a request went back to the
 * consultant's queue with no stated preference and they re-allocated
 * unilaterally. A proposal attaches the concrete times the initiator wants.
 *
 * The load-bearing rule is that auto-confirmation is ASYMMETRIC. A consultee's
 * proposal may confirm with no approval step, because publishing availability
 * is standing consent to be booked inside it — confirming there asks nothing
 * new of the consultant. The reverse does not hold: a consultee merely being
 * free at a time is not consent to be moved to it, so a consultant-initiated
 * proposal always waits for the consultee.
 *
 * Kept free of Prisma-client imports so the policy is unit-testable without a
 * database; the route owns the writes.
 */

import type { RescheduleInitiatorRole } from "@prisma/client";

/** Ceiling on how long an unanswered proposal may sit. */
export const PROPOSAL_MAX_LIFETIME_HOURS = 72;

/**
 * A proposal must resolve before the session it concerns arrives, with the same
 * margin the reschedule policy itself demands.
 */
export const PROPOSAL_RESOLVE_BEFORE_SESSION_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * When an unanswered proposal lapses.
 *
 * Two bounds, whichever comes first. A proposal about a session three months
 * out can safely wait days; one about a session this week has to be answered
 * before the session itself happens, or the booking silently stands and nobody
 * attends. A single fixed timer gets one of those two cases wrong.
 *
 * Returns null when the earliest released session is already inside the resolve
 * margin — such a reschedule should have been rejected by the 24-hour policy
 * gate before reaching here, so a caller seeing null has a bug upstream.
 */
export function computeProposalExpiry(
  releasedSlotStarts: Date[],
  now: Date = new Date(),
): Date | null {
  if (releasedSlotStarts.length === 0) return null;

  const earliest = releasedSlotStarts.reduce((a, b) => (a < b ? a : b));
  const mustResolveBy = new Date(
    earliest.getTime() - PROPOSAL_RESOLVE_BEFORE_SESSION_HOURS * HOUR_MS,
  );
  const lifetimeCap = new Date(now.getTime() + PROPOSAL_MAX_LIFETIME_HOURS * HOUR_MS);

  const expiry = mustResolveBy < lifetimeCap ? mustResolveBy : lifetimeCap;
  return expiry <= now ? null : expiry;
}

/**
 * Whether this side's proposal is allowed to confirm without the other party.
 *
 * Only the consultee's. See the module header for why this is not symmetric —
 * it is the single rule that makes auto-accept safe rather than presumptuous.
 * Landing inside published availability and finding both calendars free is
 * necessary too, but that is the validator's job, not this predicate's.
 */
export function mayAutoConfirm(initiatorRole: RescheduleInitiatorRole): boolean {
  return initiatorRole === "CONSULTEE";
}

/**
 * Group events have no coherent "other side" to accept or counter — a webinar
 * has N attendees — so they keep the existing consultant/organizer-only
 * whole-event reschedule and never open a proposal.
 */
export function supportsProposals(appointmentType: string): boolean {
  return appointmentType === "CONSULTATION" || appointmentType === "SUBSCRIPTION";
}

/**
 * A proposal replaces released slots one-for-one. Anything else is a different
 * booking, not a reschedule, and would silently change what was paid for.
 */
export function proposalCountMatches(
  releasedSlotCount: number,
  proposedSlotCount: number,
): boolean {
  return releasedSlotCount === proposedSlotCount;
}

/** 1 = the opening proposal, 2 = the single permitted counter. */
export const MAX_PROPOSAL_ROUNDS = 2;

export function mayCounter(currentRound: number): boolean {
  return currentRound < MAX_PROPOSAL_ROUNDS;
}
