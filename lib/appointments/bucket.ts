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
  if (isPendingStatus(status)) {
    let bucket: AppointmentBucket = "needsAction";
    if (viewer === "consultee") bucket = "waiting";
    else if (viewer === "consultant") bucket = "inRequests";
    return { bucket, needsActionReason: "PENDING_APPROVAL" };
  }
  if (allOccurrencesOver(occurrences, now)) {
    return { bucket: "past", needsActionReason: null };
  }

  const active = liveOccurrences(occurrences);
  if (active.length > 0 && active.every((s) => s.isTentative)) {
    return { bucket: "needsAction", needsActionReason: "TENTATIVE" };
  }

  return { bucket: "upcoming", needsActionReason: null };
}
