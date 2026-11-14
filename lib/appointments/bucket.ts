/**
 * Lifecycle bucketing for the appointments VM. One place decides which tab
 * (Upcoming / Needs action / Waiting / Past / Cancelled) a row belongs to; schedule
 * proximity ("Today", "in 45 min") is deliberately NOT a status here — it is
 * derived display text (slots.getProximityLabel), fixing the consultant
 * page's old conflation of proximity and lifecycle in a single badge.
 */

import {
  isCancelledLikeStatus,
  isCompletedLikeStatus,
  isPendingPaymentStatus,
  isPendingStatus,
  normalizeStatus,
} from "./status";
import { liveOccurrences, allOccurrencesOver } from "./occurrences";
import { sessionGapOf } from "./normalize";
import type {
  AppointmentBucket,
  NeedsActionReason,
  OccurrenceVM,
} from "./view-model";

export interface BucketInput {
  status: string | null | undefined;
  occurrences: OccurrenceVM[];
  /** Consultant-side event with no Appointment rows yet — always needs scheduling. */
  isUnscheduled?: boolean;
  /** A consultation is one agreed session, so losing it means re-timing it. */
  kind?: string;
  /** DIRECT_CHECKOUT marks a pay-first hold: the learner's to pay, not the expert's to answer. */
  source?: string | null;
  /** Whether that hold's pay window is still open; undefined when the read does not say. */
  holdOpen?: boolean;
  /** A charge on the booking succeeded: a paid plan waiting for its times owes nothing. */
  paid?: boolean;
  /** An open reschedule: the booking waits on the other side's answer, not on a payment. */
  moving?: boolean;
  /** The viewer's own webinar or class seat is held on a payment that has not succeeded. */
  unpaidSeat?: boolean;
  now?: Date;
}

/**
 * Whose list the row is for (#1527). Omitted = the viewer-neutral split, which
 * callers like the consultee Home strip still read.
 */
export type BucketViewer = "consultant" | "consultee";

export interface BucketResult {
  bucket: AppointmentBucket;
  needsActionReason: NeedsActionReason | null;
}

export function deriveBucket(
  input: BucketInput,
  viewer?: BucketViewer,
): BucketResult {
  const { occurrences, isUnscheduled } = input;
  const now = input.now ?? new Date();
  const status = normalizeStatus(input.status);

  if (isCancelledLikeStatus(status)) {
    return { bucket: "cancelled", needsActionReason: null };
  }
  if (isCompletedLikeStatus(status)) {
    return { bucket: "past", needsActionReason: null };
  }
  if (isUnscheduled) {
    return { bucket: "needsAction", needsActionReason: "UNSCHEDULED" };
  }
  if (isPendingPaymentStatus(status)) {
    // The consultant can't act on an unpaid approval here — Requests owns it.
    return {
      bucket: viewer === "consultant" ? "inRequests" : "needsAction",
      needsActionReason: "PAY_NOW",
    };
  }
  // The viewer's own unpaid seat decides a group row: pay while it holds, else it is over.
  if (input.unpaidSeat) {
    return input.holdOpen === false
      ? { bucket: "cancelled", needsActionReason: null }
      : { bucket: "needsAction", needsActionReason: "PAY_NOW" };
  }
  // An unpaid pay-first hold is the learner's to pay; a paid one or a move is not.
  if (
    isPendingStatus(status) &&
    input.source === "DIRECT_CHECKOUT" &&
    !input.paid &&
    !input.moving
  ) {
    if (input.holdOpen === false) {
      return { bucket: "cancelled", needsActionReason: null };
    }
    return {
      bucket: viewer === "consultant" ? "inRequests" : "needsAction",
      needsActionReason: "PAY_NOW",
    };
  }
  if (isPendingStatus(status)) {
    let bucket: AppointmentBucket = "needsAction";
    if (viewer === "consultee") bucket = "waiting";
    else if (viewer === "consultant") bucket = "inRequests";
    return { bucket, needsActionReason: "PENDING_APPROVAL" };
  }
  const active = liveOccurrences(occurrences);
  // An approved booking with no live session is never "past" and never silent.
  const gap = sessionGapOf({
    kind: input.kind,
    rows: occurrences.length,
    liveRows: active.length,
  });
  if (gap) return { bucket: "needsAction", needsActionReason: gap };
  // Over by the clock: listed under Past, where the badge still waits for the outcome.
  if (allOccurrencesOver(occurrences, now)) {
    return { bucket: "past", needsActionReason: null };
  }

  if (active.length > 0 && active.every((s) => s.isTentative)) {
    return { bucket: "needsAction", needsActionReason: "TENTATIVE" };
  }

  return { bucket: "upcoming", needsActionReason: null };
}

/** What a row with no live session says in place of a time. */
export function noSessionLabel(reason: NeedsActionReason | null): string {
  if (reason === "AWAITING_SCHEDULING") return "Awaiting scheduling";
  if (reason === "NEEDS_RESCHEDULING") return "Needs rescheduling";
  return "Not scheduled";
}
