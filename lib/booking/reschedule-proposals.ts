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

import type { AppointmentsType, RescheduleInitiatorRole } from "@prisma/client";
import type { RescheduleOutcomeFields } from "@/lib/novu/workflows";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";

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

  // Seeded rather than relying on the length guard above: an unseeded reduce on
  // an empty array throws, and a future caller reordering these two lines would
  // turn a null return into a crash.
  const earliest = releasedSlotStarts.reduce(
    (a, b) => (a < b ? a : b),
    releasedSlotStarts[0],
  );
  const mustResolveBy = new Date(
    earliest.getTime() - PROPOSAL_RESOLVE_BEFORE_SESSION_HOURS * HOUR_MS,
  );
  const lifetimeCap = new Date(
    now.getTime() + PROPOSAL_MAX_LIFETIME_HOURS * HOUR_MS,
  );

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
export function mayAutoConfirm(
  initiatorRole: RescheduleInitiatorRole,
): boolean {
  return initiatorRole === "CONSULTEE";
}

/**
 * Group events have no coherent "other side" to accept or counter — a webinar
 * has N attendees — so they keep the existing consultant/organizer-only
 * whole-event reschedule and never open a proposal.
 */
export function supportsProposals(
  // The enum rather than `string`, so a mistyped literal is a compile error
  // instead of a silent `false`. Nullable because the caller derives the type
  // from the row and may not find one.
  appointmentType: AppointmentsType | null | undefined,
): boolean {
  return (
    appointmentType === "CONSULTATION" || appointmentType === "SUBSCRIPTION"
  );
}

/** A window either side of the atom count is measured in. */
interface AtomWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The 30-minute atoms one window covers, from the window's own bounds.
 *
 * `SCHEDULING_INTERVAL_MS` rather than a literal because the atom is what every
 * booking lock, the overlap exclusion and the allocator's `slotsPerCall` are
 * built on — a second declaration of "half an hour" here is how the two sides
 * of a comparison drift apart silently. Rounded rather than floored so a stray
 * millisecond cannot make a correct proposal read as a short one; clamped at
 * zero so an inverted window contributes nothing instead of subtracting.
 */
function atomsIn({ startsAt, endsAt }: AtomWindow): number {
  const durationMs = endsAt.getTime() - startsAt.getTime();
  return durationMs <= 0 ? 0 : Math.round(durationMs / SCHEDULING_INTERVAL_MS);
}

/**
 * Atoms the RELEASED side covers.
 *
 * One `AppointmentOccurrence` row is one whole session, whose length is the
 * plan's `slotsPerSession` — counting rows instead of atoms understates the
 * coverage of every session longer than 30 minutes, which is what made a
 * 1-hour session impossible to reschedule: one row against the two atoms the
 * calendar expands a click into.
 */
export function releasedAtomCount(
  occurrences: ReadonlyArray<AtomWindow>,
): number {
  return occurrences.reduce((total, row) => total + atomsIn(row), 0);
}

/**
 * Atoms the PROPOSED side covers, measured the same way rather than assumed.
 *
 * Each row of `proposedSlots` is exactly one atom — the Zod refine says so, and
 * the allocator needs it to — but assuming it on this side and measuring the
 * other would be the same two-units bug in a new place. Both sides are counted
 * from their bounds so the comparison is between like and like.
 */
export function proposedAtomCount(slots: ReadonlyArray<AtomWindow>): number {
  return slots.reduce((total, row) => total + atomsIn(row), 0);
}

/**
 * A proposal must replace exactly the COVERAGE it released. Anything else is a
 * different booking, not a reschedule, and would silently change what was paid
 * for.
 *
 * The two numbers are atom counts, not row counts: released rows are whole
 * sessions, proposed rows are single atoms, and only atoms are commensurable.
 * It is also exactly the rule the allocator enforces downstream
 * (`slots.length === releasedSessions × slotsPerCall`), so a proposal that
 * passes here cannot be refused there for being the wrong size — which is the
 * guarantee the previous row-count comparison broke for every session longer
 * than 30 minutes.
 */
export function proposalCountMatches(
  releasedAtomTotal: number,
  proposedAtomTotal: number,
): boolean {
  return releasedAtomTotal === proposedAtomTotal;
}

/**
 * The route's one call: does this payload replace what was released?
 *
 * Total minutes equal and atom counts equal are the same statement at a fixed
 * atom length, so the atom comparison IS the coverage comparison; the minutes
 * are not added because a second expression of the same test can only drift.
 */
export function proposalCoverageMatches(
  released: ReadonlyArray<AtomWindow>,
  proposed: ReadonlyArray<AtomWindow>,
): boolean {
  return proposalCountMatches(
    releasedAtomCount(released),
    proposedAtomCount(proposed),
  );
}

/**
 * Which sentence the reschedule notification should render.
 *
 * The three outcomes the route already distinguishes in its response message
 * are the same three a recipient needs told apart: you were moved, you were
 * asked, or the time was given up and nobody has picked a new one. Collapsing
 * them into one "moved from X to Y" template is what left the released case
 * interpolating two empty strings.
 *
 * `releasedAt` is the earliest slot handed back, `proposedAt` the earliest time
 * asked for — earliest rather than all of them because a multi-session
 * reschedule still needs one sentence.
 */
export function rescheduleNotificationVariant(args: {
  releasedAt: Date | null;
  proposedAt: Date | null;
  autoConfirmed: boolean;
}): RescheduleOutcomeFields {
  const { releasedAt, proposedAt, autoConfirmed } = args;

  // A destination needs both ends: the arms carrying `newDateTime` also carry
  // `oldDateTime`, so a missing released time falls back to RELEASED rather
  // than half-filling the sentence.
  if (releasedAt && proposedAt) {
    return {
      outcome: autoConfirmed ? "MOVED" : "PROPOSED",
      oldDateTime: releasedAt.toISOString(),
      newDateTime: proposedAt.toISOString(),
    };
  }

  return {
    outcome: "RELEASED",
    ...(releasedAt ? { oldDateTime: releasedAt.toISOString() } : {}),
  };
}

/**
 * Which of the propose-response outcomes happened, as a code a client may
 * branch on. The `message` beside it is prose and is free to change; this is
 * the contract.
 *
 * The proposal row's own `status` is not on the wire, and the response used to
 * carry no answer either, so a client could only infer the outcome from the
 * presence of a proposal id — which cannot tell "waiting for the consultant"
 * from "the row is gone". `autoConfirmReason` (#FAMILIARISE_WEB-2W) carried the
 * cause but not the answer, and the message claimed one fixed cause regardless.
 */
export type RescheduleProposeCode =
  /** The times were placed without asking anyone. */
  | "AUTO_CONFIRMED"
  /** No concrete times were named: a plain release, or preference-only. */
  | "RELEASED"
  /** A proposal is open and the counterparty has it to answer. */
  | "AWAITING_ANSWER"
  /**
   * A proposal is open, but auto-confirmation detected a reason it would not
   * place the times — the free calendar is not enough, and a human has to place
   * them.
   */
  | "NOT_PLACEABLE"
  /** The proposal is no longer answerable: it was answered, expired or lost. */
  | "PROPOSAL_CLOSED";

/**
 * Refusals that mean the proposal row is GONE, so nothing is waiting on
 * anybody. Enumerated rather than inferred, because the two errors are opposite
 * and the user pays for confusing them: telling someone a proposal is with the
 * consultant when the row has been answered or expired means waiting for a
 * decision that will never come.
 *
 * Closed by absence-of-row (`PROPOSAL_NOT_FOUND`), a status that is no longer
 * open (`PROPOSAL_NOT_OPEN` — a lapsed row can still answer `PENDING_REVIEW` for
 * up to an hour), and the finalize CAS losing its race (`TRANSITION_REFUSED`,
 * set by the route).
 */
const CLOSED_AUTO_CONFIRM_REFUSALS = new Set([
  "PROPOSAL_NOT_FOUND",
  "PROPOSAL_NOT_OPEN",
  "TRANSITION_REFUSED",
]);

/**
 * Refusals that leave the proposal open AND leave the consultant as the next
 * actor, so the sentence may name them: the times were never ours to place
 * (`CONSULTANT_INITIATED`), or the attempt never reached a decision
 * (`APPOINTMENT_BUSY`, `BOOKING_LOCK_UNAVAILABLE`, `ERROR`).
 *
 * Anything unrecognised — a typed `AllocationErrorCode`, or one added after this
 * was written — falls to NOT_PLACEABLE, whose sentence asserts only that the
 * time was not confirmed automatically. An unrecognised reason must not be
 * dressed up as a specific cause, and the raw reason is on the wire beside it.
 */
const AWAITING_AUTO_CONFIRM_REFUSALS = new Set([
  "CONSULTANT_INITIATED",
  "APPOINTMENT_BUSY",
  "BOOKING_LOCK_UNAVAILABLE",
  "ERROR",
]);

/**
 * The propose route's terminal sentence and its branchable code.
 *
 * Built here, beside the proposal policy, so the two cannot drift: a refusal
 * reason the server already detected must not reach the user as the fixed
 * "sent to the consultant" sentence, which asserts a human action the server
 * may have just proved unnecessary or impossible.
 */
export function rescheduleProposeOutcome(args: {
  autoConfirmed: boolean;
  /** A row a counterparty can answer — absent for a preference-only proposal. */
  hasProposal: boolean;
  /** `tryAutoConfirmProposal`'s reason; null when it was never attempted. */
  autoConfirmReason: string | null;
  /** The route's own release sentence, for the no-proposal arm. */
  releaseMessage: string;
}): { code: RescheduleProposeCode; message: string } {
  const { autoConfirmed, hasProposal, autoConfirmReason, releaseMessage } =
    args;

  if (autoConfirmed) {
    return {
      code: "AUTO_CONFIRMED",
      message: "Your new time is confirmed.",
    };
  }
  if (!hasProposal) {
    return { code: "RELEASED", message: releaseMessage };
  }
  if (
    autoConfirmReason !== null &&
    CLOSED_AUTO_CONFIRM_REFUSALS.has(autoConfirmReason)
  ) {
    return {
      code: "PROPOSAL_CLOSED",
      message:
        "This request is no longer pending — the booking has moved on since you submitted it.",
    };
  }
  if (
    autoConfirmReason === null ||
    AWAITING_AUTO_CONFIRM_REFUSALS.has(autoConfirmReason)
  ) {
    return {
      code: "AWAITING_ANSWER",
      message: "Your requested time has been sent to the consultant.",
    };
  }
  return {
    code: "NOT_PLACEABLE",
    message:
      "We could not confirm that time automatically, so it is with the consultant to place. Nothing has been charged or moved yet.",
  };
}

/*
 * There is deliberately no counter-round.
 *
 * MAX_PROPOSAL_ROUNDS and mayCounter lived here, and the COUNTERED status is
 * still in the enum and the transition map — but nothing ever wrote it. The
 * round-2 path was specified and never built, so removing it costs nothing and
 * leaves one fewer half-implemented state to reason about.
 *
 * Propose -> accept or decline is the whole flow. A decline does not dead-end
 * anything: it puts the original time back, or — when that time is gone — leaves
 * the released sessions in the consultant's allocate queue.
 */

/**
 * What a decline did to the released sessions, as a code a client may branch on.
 *
 * NOT a subset of `RescheduleProposeCode`, and deliberately not renamed to fit
 * it: the two routes answer different questions. The propose route answers "is
 * my proposal still waiting for somebody", which is the initiator's question
 * minutes after proposing. The respond route answers "where are the released
 * sessions now", which only the counterparty asking can be told. Forcing either
 * vocabulary onto the other's question is what would produce a mapping nobody can
 * implement, so the relationship between them is published below instead of
 * being papered over with a merged union.
 */
export type RescheduleRespondCode = "DECLINED" | "RELEASED";

/**
 * The lifecycle's terminal events, and the code each of the two reschedule
 * routes reports for one. THE mapping — a client holding an open proposal and
 * then seeing `PROPOSAL_CLOSED` on its next propose reads it here rather than
 * inferring the counterparty's answer from a route it was not talking to.
 *
 * `RescheduleProposeCode` is the authoritative vocabulary: it names every state
 * the PROPOSAL itself can end in, including the one no respond route reports (a
 * proposal that lapsed unanswered), so it is the only one of the two that can
 * describe a client's whole lifecycle. Every `RescheduleRespondCode` member
 * appears as some event's `respond` value, and each of those events also names
 * the propose-side code that follows — so no respond outcome is unmapped.
 *
 * The projection is lossy in one direction and that loss is the point, not a
 * defect to paper over: all three of DECLINED, RELEASED and the sweep's lapse
 * land on `PROPOSAL_CLOSED`, because from the initiator's side an answered
 * proposal and a lapsed one are the same shape. Which of the three happened is
 * on the `RescheduleRequest` row and in the Novu outcome, not on the propose
 * response — a client that needs the distinction must read one of those.
 *
 * `RELEASED` is the one word the two vocabularies share and it means the same
 * thing in both — released slots, no replacement time chosen — while naming two
 * different causes (a proposal that named no times; a decline that could not put
 * every row back). A client keying on the word gets the right headline either
 * way, which is why the collision is left standing rather than disambiguated.
 *
 * `null` means the surface never reports this event: there is no answer to give
 * (`AUTO_CONFIRMED`, a proposal still open) or that route was never involved.
 */
export const RESCHEDULE_TERMINAL_EVENT_CODES = {
  TIMES_PLACED_WITHOUT_ASKING: { propose: "AUTO_CONFIRMED", respond: null },
  PROPOSAL_OPEN_WITH_THE_COUNTERPARTY: {
    propose: "AWAITING_ANSWER",
    respond: null,
  },
  // Open, but auto-confirmation refused: the free calendar is not enough, so a
  // human still has to place the times. The distinction a client needs from
  // AWAITING_ANSWER, and the reason the two are separate members.
  PROPOSAL_OPEN_NEEDS_A_HUMAN: { propose: "NOT_PLACEABLE", respond: null },
  RELEASED_WITH_NO_TIMES_NAMED: { propose: "RELEASED", respond: null },
  DECLINED_AND_ALL_ROWS_RESTORED: {
    propose: "PROPOSAL_CLOSED",
    respond: "DECLINED",
  },
  DECLINED_AND_SOME_ROWS_STRANDED: {
    propose: "PROPOSAL_CLOSED",
    respond: "RELEASED",
  },
  // The sweep's, not anybody's answer: unanswered until the deadline. Only the
  // propose route can report it, which is exactly why the authoritative
  // vocabulary has a member the respond route never emits.
  LAPSED_UNANSWERED: { propose: "PROPOSAL_CLOSED", respond: null },
} as const satisfies Record<
  string,
  { propose: RescheduleProposeCode; respond: RescheduleRespondCode | null }
>;
