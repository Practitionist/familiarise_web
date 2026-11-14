/**
 * The one status a booking or seat shows to every viewer: one of seven words
 * (Requested, Awaiting payment, Confirmed or Registered, Being moved,
 * Completed, Cancelled, Refunded) with one plain reason line. A host's own
 * webinar or class keeps its event words. Prisma-free: lists, the detail page
 * and the back office all call it. It names what the rows say; legality lives
 * in `lib/booking/transitions.ts`.
 */

import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { eventStatusBadge } from "@/lib/labels/session-labels";
import { toneClass, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

/** Where the booking is in its life; several stages share one word. */
export const BOOKING_STAGES = [
  "REQUESTED",
  "AWAITING_PAYMENT",
  "PAYMENT_LAPSED",
  "CONFIRMED",
  "AWAITING_ALLOCATION",
  "BEING_MOVED",
  "COMPLETED",
  "CANCELLED",
  "DECLINED",
] as const;
export type BookingStage = (typeof BOOKING_STAGES)[number];

/** The seven words; "Registered" is how a seat says Confirmed. */
export const BOOKING_WORDS = [
  "Requested",
  "Awaiting payment",
  "Confirmed",
  "Registered",
  "Being moved",
  "Completed",
  "Cancelled",
  "Refunded",
] as const;
export type BookingWord = (typeof BOOKING_WORDS)[number];

export type StatusViewer = "CONSULTANT" | "CONSULTEE" | "ORG_ADMIN" | "STAFF";

/** One lifecycle edge; `by` is the side that wrote it, null for the system. */
export type HistoryEdgeInput = {
  fromStatus: string;
  toStatus: string;
  reason?: string | null;
  by?: "CONSULTANT" | "REQUESTER" | "OTHER" | null;
  createdAt?: Date | string | null;
};

/** An open reschedule: who proposed it, the first proposed and the original start. */
export interface OpenRescheduleInput {
  by: "CONSULTANT" | "REQUESTER";
  /** The viewer proposed it; undefined when the read cannot say (then the side decides). */
  mine?: boolean;
  proposedStartsAt: Date | string | null;
  originalStartsAt: Date | string | null;
  expiresAt: Date | string | null;
}

export interface BookingStatusFacts {
  /** CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS or TRIAL. */
  kind: string;
  /** The stored lifecycle status of the booking (or the event, for a seat). */
  status: string | null | undefined;
  /** DIRECT_CHECKOUT (pay first) or REQUEST_SUBMITTED. */
  source?: string | null;
  /** The viewer's own seat on a webinar or class. */
  seatStatus?: string | null;
  /** When that seat was given back, for its reason line. */
  seatReleasedAt?: Date | string | null;
  /** The row is a whole webinar or class (a back-office list), not a seat. */
  eventView?: boolean;
  /** A charge on the booking succeeded. */
  paid?: boolean;
  /** When the unpaid pay window closes; null or undefined when none is known. */
  payDeadline?: Date | string | null;
  /** Evidence the hold lapsed: its payment expired or failed and nothing payable is open. */
  payLapsed?: boolean;
  /** An unpaid pay link was minted at some point (reads a history-less EXPIRED row). */
  unpaidLinkSeen?: boolean;
  reschedule?: OpenRescheduleInput | null;
  /** Refunds that have landed, summed. */
  refunded?: {
    paise: number;
    currency: string;
    at: Date | string | null;
  } | null;
  /** Live sessions on the calendar; omitted when the read carries none. */
  sessions?: {
    live: number;
    allTentative: boolean;
    done: boolean;
    /** Every session's time has passed with no outcome recorded yet. */
    awaitingOutcome?: boolean;
  };
  /** A plan's end has passed; until then held sessions never complete the plan. */
  planEnded?: boolean;
  /** A paid plan waiting for its first or its next placement. */
  planWait?: "CYCLE_1" | "NEXT_CYCLE" | null;
  allocateBy?: Date | string | null;
  nextBatch?: number;
  history?: HistoryEdgeInput[];
  cancelledAt?: Date | string | null;
  /** A short line a completed plan carries (the sessions it never held). */
  completedNote?: string | null;
  names?: { payer: string; consultant: string };
}

export interface BookingStatus {
  stage: BookingStage;
  label: string;
  tone: Tone;
  /** One plain sentence under the badge; empty when the word says it all. */
  line: string;
}

export interface BookingStatusOptions {
  now?: Date;
  zone?: string | null;
}

const WORD_TONE: Record<BookingWord, Tone> = {
  Requested: "caution",
  "Awaiting payment": "warning",
  Confirmed: "success",
  Registered: "success",
  "Being moved": "info",
  Completed: "success",
  Cancelled: "neutral",
  Refunded: "neutral",
};

const EVENT_TONE: Record<string, Tone> = {
  DRAFT: "caution",
  SCHEDULED: "info",
  COMPLETED: "success",
  CANCELLED: "neutral",
};

const GROUP_KINDS = new Set(["WEBINAR", "CLASS"]);
const UNPAID_OPEN = new Set([
  "PENDING",
  "APPROVED_PENDING_PAYMENT",
  "AWAITING_PAYMENT",
]);
const CONFIRMED_FAMILY = new Set(["APPROVED", "SCHEDULED", ""]);
const COMPLETED_FAMILY = new Set(["COMPLETED", "CONVERTED"]);
const RELEASED_SEAT = new Set(["CANCELLED", "REFUNDED"]);
// The consultant's withdraw-approval and the capture write these reasons.
const WITHDRAWN_BY_CONSULTANT = "WITHDRAWN_BY_CONSULTANT";
const PAYMENT_CAPTURED = "payment captured";

const upper = (v: string | null | undefined) => v?.toUpperCase() ?? "";
const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const asDate = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(v);
const zoneOf = (zone?: string | null) =>
  zone ??
  (typeof Intl === "undefined"
    ? "UTC"
    : Intl.DateTimeFormat().resolvedOptions().timeZone);

type EndCause =
  | "DECLINED"
  | "UNANSWERED"
  | "UNPLACED"
  | "PAYMENT_LAPSED"
  | "REQUEST_WITHDRAWN"
  | "APPROVAL_WITHDRAWN"
  | "SEAT_RELEASED"
  | "CANCELLED";

/** Is this a host looking at their own webinar or class? */
function isHostEvent(f: BookingStatusFacts, viewer: StatusViewer): boolean {
  return (
    GROUP_KINDS.has(upper(f.kind)) && (viewer === "CONSULTANT" || !!f.eventView)
  );
}

/** The latest edge into the booking's current status. */
function edgeInto(f: BookingStatusFacts, status: string) {
  const edges = (f.history ?? []).filter((e) => upper(e.toStatus) === status);
  return edges.at(-1) ?? null;
}

/** Why an EXPIRED or CANCELLED booking ended, read off its history edge. */
function endCause(f: BookingStatusFacts, status: string): EndCause {
  const source = upper(f.source);
  const edge = edgeInto(f, status);
  const from = upper(edge?.fromStatus);
  if (status === "REJECTED") return "DECLINED";
  if (status === "EXPIRED") {
    if (!edge) return f.unpaidLinkSeen ? "PAYMENT_LAPSED" : "UNANSWERED";
    if (from === "APPROVED") return "UNPLACED";
    if (from === "PENDING" && source !== "DIRECT_CHECKOUT") return "UNANSWERED";
    return "PAYMENT_LAPSED";
  }
  if (edge?.reason === WITHDRAWN_BY_CONSULTANT) return "APPROVAL_WITHDRAWN";
  if (edge && !edge.by && UNPAID_OPEN.has(from)) return "PAYMENT_LAPSED";
  if (
    edge?.by === "REQUESTER" &&
    source === "REQUEST_SUBMITTED" &&
    (from === "PENDING" || from === "APPROVED_PENDING_PAYMENT")
  ) {
    return "REQUEST_WITHDRAWN";
  }
  return "CANCELLED";
}

function stageOf(
  f: BookingStatusFacts,
  now: Date,
): { stage: BookingStage; cause?: EndCause } {
  const status = upper(f.status);
  const kind = upper(f.kind);
  const seat = upper(f.seatStatus);
  const deadline = asDate(f.payDeadline);
  // Lapsed only on evidence: a known deadline passed, or the payment expired or failed.
  // An unknown deadline reads "Awaiting payment" without a countdown.
  const lapsed = (!!deadline && deadline <= now) || f.payLapsed === true;

  // The host cancelling the event and the learner's own seat being released read differently.
  if (RELEASED_SEAT.has(seat)) {
    return {
      stage: "CANCELLED",
      cause: status === "CANCELLED" ? "CANCELLED" : "SEAT_RELEASED",
    };
  }
  if (seat === "HELD" && !f.paid) {
    return lapsed ? { stage: "PAYMENT_LAPSED" } : { stage: "AWAITING_PAYMENT" };
  }
  if (status === "REJECTED") return { stage: "DECLINED", cause: "DECLINED" };
  if (status === "EXPIRED" || status === "CANCELLED") {
    const cause = endCause(f, status);
    return cause === "PAYMENT_LAPSED"
      ? { stage: "PAYMENT_LAPSED", cause }
      : { stage: "CANCELLED", cause };
  }
  if (COMPLETED_FAMILY.has(status)) return { stage: "COMPLETED" };
  if (f.reschedule) return { stage: "BEING_MOVED" };
  if (f.planWait) return { stage: "AWAITING_ALLOCATION" };
  if (status === "DRAFT") return { stage: "AWAITING_ALLOCATION" };
  if (UNPAID_OPEN.has(status)) {
    const payFirst = upper(f.source) === "DIRECT_CHECKOUT" || kind === "TRIAL";
    if (f.paid) return { stage: payFirst ? "CONFIRMED" : "REQUESTED" };
    if (status === "PENDING" && !payFirst) return { stage: "REQUESTED" };
    return lapsed ? { stage: "PAYMENT_LAPSED" } : { stage: "AWAITING_PAYMENT" };
  }
  const sessions = f.sessions;
  if (sessions && sessions.live === 0) return { stage: "AWAITING_ALLOCATION" };
  if (CONFIRMED_FAMILY.has(status) && sessions) {
    if (sessions.allTentative) {
      return { stage: f.paid ? "CONFIRMED" : "AWAITING_PAYMENT" };
    }
    // A plan completes at its stored end or its plan end, not when the placed sessions are held.
    if (sessions.done && (kind !== "SUBSCRIPTION" || f.planEnded)) {
      return { stage: "COMPLETED" };
    }
  }
  return { stage: "CONFIRMED" };
}

function wordOf(
  stage: BookingStage,
  f: BookingStatusFacts,
  viewer: StatusViewer,
): BookingWord {
  switch (stage) {
    case "REQUESTED":
      return "Requested";
    case "AWAITING_PAYMENT":
      return "Awaiting payment";
    case "BEING_MOVED":
      return "Being moved";
    case "COMPLETED":
      return "Completed";
    case "CONFIRMED":
    case "AWAITING_ALLOCATION":
      return GROUP_KINDS.has(upper(f.kind)) && viewer !== "CONSULTANT"
        ? "Registered"
        : "Confirmed";
    default:
      return (f.refunded?.paise ?? 0) > 0 ? "Refunded" : "Cancelled";
  }
}

function reasonOf(
  stage: BookingStage,
  cause: EndCause | undefined,
  word: BookingWord,
  f: BookingStatusFacts,
  viewer: StatusViewer,
  zone: string,
  now: Date,
): string {
  const consultant = f.names?.consultant ?? "the expert";
  const payer = f.names?.payer ?? "the learner";
  const isExpert = viewer === "CONSULTANT";
  const isLearner = viewer === "CONSULTEE";
  const day = (d: Date) => formatInViewerZone(d, zone, "d MMM");
  const dayTime = (d: Date) => formatInViewerZone(d, zone, "EEE d MMM, h:mm a");
  const deadline = asDate(f.payDeadline);

  if (word === "Refunded" && f.refunded) {
    const at = asDate(f.refunded.at);
    const amount = formatCurrencyAmount(f.refunded.paise, f.refunded.currency);
    return at ? `${amount} refunded on ${day(at)}.` : `${amount} refunded.`;
  }
  switch (stage) {
    case "REQUESTED":
      if (f.paid) return `Paid; ${consultant} is asked to approve next.`;
      if (isExpert) return `${cap(payer)} is waiting for your answer.`;
      return `Waiting for ${consultant} to answer (within 48 hours).`;
    case "AWAITING_PAYMENT":
      if (!deadline)
        return isLearner
          ? "Pay to confirm it."
          : `Waiting for ${payer} to pay.`;
      return isLearner
        ? `Pay by ${dayTime(deadline)}.`
        : `${cap(payer)} has until ${dayTime(deadline)} to pay.`;
    case "AWAITING_ALLOCATION": {
      if (upper(f.status) === "DRAFT")
        return "Publish it once a session is set.";
      const by = asDate(f.allocateBy);
      if (f.planWait === "NEXT_CYCLE") {
        const next = f.nextBatch ?? 0;
        return isExpert
          ? `Week done. Schedule the next ${next}.`
          : `Week done. ${cap(consultant)} is placing the next ${next}.`;
      }
      if (isExpert) {
        return by
          ? `Paid. Place the first sessions by ${dayTime(by)}.`
          : "Place the sessions on the calendar.";
      }
      if (f.planWait === "CYCLE_1" && by && by.getTime() <= now.getTime()) {
        return isLearner
          ? `Paid. ${cap(consultant)} has not arranged times yet; they were due by ${dayTime(by)}. You can cancel this plan from this page.`
          : `Paid. ${cap(consultant)} has not arranged times yet; they were due by ${dayTime(by)}.`;
      }
      return f.planWait === "CYCLE_1"
        ? isLearner
          ? "Paid. Your expert is arranging times (within 48 hours)."
          : `Paid. ${cap(consultant)} is arranging times (within 48 hours).`
        : `${cap(consultant)} has not placed the sessions on the calendar yet.`;
    }
    case "BEING_MOVED": {
      const r = f.reschedule;
      if (!r) return "";
      const mine =
        r.mine ??
        ((r.by === "CONSULTANT" && isExpert) ||
          (r.by === "REQUESTER" && isLearner));
      const who = cap(
        mine ? "you" : r.by === "CONSULTANT" ? consultant : payer,
      );
      const proposed = asDate(r.proposedStartsAt);
      const original = asDate(r.originalStartsAt);
      const asked = proposed
        ? `${who} proposed ${dayTime(proposed)}`
        : `${who} asked for a new time`;
      return original
        ? `${asked}; originally ${dayTime(original)}.`
        : `${asked}.`;
    }
    case "CONFIRMED":
      if (f.paid && f.sessions?.allTentative) {
        return "Payment received; the session is being locked in.";
      }
      return f.sessions?.awaitingOutcome
        ? "This session's time has passed. We're confirming what happened."
        : "";
    case "COMPLETED":
      return f.completedNote ?? "";
    case "PAYMENT_LAPSED":
      return "Payment was not completed in time.";
    default:
      return endedReason(cause, f, viewer, consultant, payer, day);
  }
}

function endedReason(
  cause: EndCause | undefined,
  f: BookingStatusFacts,
  viewer: StatusViewer,
  consultant: string,
  payer: string,
  day: (d: Date) => string,
): string {
  const isExpert = viewer === "CONSULTANT";
  const isLearner = viewer === "CONSULTEE";
  switch (cause) {
    case "DECLINED":
      return isExpert
        ? "You declined this request."
        : "The expert declined this request.";
    case "UNANSWERED":
      return isExpert
        ? "You did not answer in 48 hours."
        : "The expert did not answer in 48 hours.";
    case "UNPLACED":
      return isExpert
        ? "You did not place the sessions in time."
        : "The expert did not place the sessions in time.";
    case "REQUEST_WITHDRAWN":
      return isLearner
        ? "You withdrew this request."
        : `${cap(payer)} withdrew this request.`;
    case "SEAT_RELEASED": {
      // The seat row does not record whether the learner left or was removed.
      const at = asDate(f.seatReleasedAt);
      return `Your place on this event was released${at ? ` on ${day(at)}` : ""}.`;
    }
    case "APPROVAL_WITHDRAWN":
      return isExpert
        ? "You withdrew the approval before it was paid."
        : `${cap(consultant)} withdrew the approval before it was paid.`;
    default: {
      const status = upper(f.status);
      if (RELEASED_SEAT.has(upper(f.seatStatus))) {
        return "This event was cancelled by the host.";
      }
      const edge = edgeInto(f, status);
      const at = asDate(edge?.createdAt ?? f.cancelledAt);
      const by = edge?.by;
      const mine =
        (by === "CONSULTANT" && isExpert) || (by === "REQUESTER" && isLearner);
      let who = "";
      if (mine) who = " by you";
      else if (by === "CONSULTANT") who = ` by ${consultant}`;
      else if (by === "REQUESTER") who = ` by ${payer}`;
      return `Cancelled${who}${at ? ` on ${day(at)}` : ""}.`;
    }
  }
}

/** The badge word, its tone and the reason line for this viewer. */
export function bookingStatus(
  f: BookingStatusFacts,
  viewer: StatusViewer,
  options: BookingStatusOptions = {},
): BookingStatus {
  const now = options.now ?? new Date();
  const zone = zoneOf(options.zone);
  const { stage, cause } = stageOf(f, now);
  const status = upper(f.status);
  if (isHostEvent(f, viewer) && status in EVENT_TONE) {
    return {
      stage,
      label: eventStatusBadge(status).label,
      tone: EVENT_TONE[status],
      line: "",
    };
  }
  const word = wordOf(stage, f, viewer);
  return {
    stage,
    label: word,
    tone: WORD_TONE[word],
    line: reasonOf(stage, cause, word, f, viewer, zone, now),
  };
}

/** `StatusBadge` props for a status. */
export function bookingStatusBadge(s: Pick<BookingStatus, "label" | "tone">) {
  return { label: s.label, ...toneClass(s.tone) };
}

/** The first edge that is the expert approving a submitted request, if any. */
export function expertApproval(
  f: Pick<BookingStatusFacts, "history" | "source">,
): HistoryEdgeInput | null {
  if (upper(f.source) === "DIRECT_CHECKOUT") return null;
  return (
    (f.history ?? []).find(
      (e) =>
        upper(e.fromStatus) === "PENDING" &&
        (upper(e.toStatus) === "APPROVED" ||
          upper(e.toStatus) === "APPROVED_PENDING_PAYMENT") &&
        e.reason !== PAYMENT_CAPTURED,
    ) ?? null
  );
}
