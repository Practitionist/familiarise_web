import { z } from "zod";

/** Every value `Meeting.endedReason` may hold; the sidecar CHECK `meeting_ended_reason_known` admits only these. */
export const MEETING_END_REASONS = [
  "call_ended",
  "maintenance",
  "org_deactivated",
  "org_deleted",
  "session_timeout",
  "ended_early",
  "stream_ended",
  "reconciled",
  "reconciled_no_end",
  "stream_not_found",
  "stream_not_configured",
] as const;

export const meetingEndReasonSchema = z.enum(MEETING_END_REASONS);
export type MeetingEndReason = z.infer<typeof meetingEndReasonSchema>;

/** What an end means to money: a host's deliberate close, a platform outage, or nothing. */
export type EndReasonMoney = "host_end" | "outage" | "none";

export interface EndReasonPolicy {
  /** A person or ops closed the room on purpose; no later end event may overwrite it. */
  deliberate: boolean;
  /** Participants may come back to the same room; a join reopens or rebuilds it. */
  rejoinable: boolean;
  /** The host may reopen the room on a fresh call id inside the rejoin window. */
  hostReopenable: boolean;
  money: EndReasonMoney;
}

const policy = (
  deliberate: boolean,
  rejoinable: boolean,
  hostReopenable: boolean,
  money: EndReasonMoney,
): EndReasonPolicy => ({ deliberate, rejoinable, hostReopenable, money });

export const END_REASON_POLICY: Readonly<
  Record<MeetingEndReason, EndReasonPolicy>
> = {
  call_ended: policy(true, false, true, "host_end"),
  maintenance: policy(true, false, true, "outage"),
  org_deactivated: policy(true, false, false, "none"),
  org_deleted: policy(true, false, false, "none"),
  session_timeout: policy(false, true, false, "none"),
  ended_early: policy(false, true, false, "none"),
  stream_ended: policy(false, false, true, "none"),
  reconciled: policy(false, false, false, "none"),
  reconciled_no_end: policy(false, false, false, "none"),
  stream_not_found: policy(false, false, false, "none"),
  stream_not_configured: policy(false, false, false, "none"),
};

/** An ended row with no reason predates the vocabulary and is read as a host's deliberate close. */
const UNNAMED_END_POLICY = policy(true, false, true, "none");

/** The policy for a stored reason; a value outside the vocabulary reads as a Stream-sealed room. */
export function endReasonPolicy(
  reason: string | null | undefined,
): EndReasonPolicy {
  if (!reason) return UNNAMED_END_POLICY;
  const parsed = meetingEndReasonSchema.safeParse(reason);
  return parsed.success
    ? END_REASON_POLICY[parsed.data]
    : END_REASON_POLICY.stream_ended;
}

type EndedMeeting = {
  endedAt: Date | string | null;
  endedReason?: string | null;
} | null;

/** True when the room has ended and a participant join can neither continue nor rebuild it. */
export function endBlocksRejoin(meeting?: EndedMeeting): boolean {
  if (!meeting?.endedAt) return false;
  return !endReasonPolicy(meeting.endedReason).rejoinable;
}

/** True when the recorded end lets the host reopen the room on a fresh call id. */
export function endAllowsHostReopen(meeting?: EndedMeeting): boolean {
  if (!meeting?.endedAt) return false;
  return endReasonPolicy(meeting.endedReason).hostReopenable;
}

/** True when a recorded end must survive a later `incoming` end: a deliberate end always, a sealed end unless the newcomer is deliberate. */
export function recordedEndHolds(
  meeting: EndedMeeting | undefined,
  incoming: MeetingEndReason,
): boolean {
  if (!meeting?.endedAt) return false;
  const recorded = endReasonPolicy(meeting.endedReason);
  if (recorded.deliberate) return true;
  return !recorded.rejoinable && !END_REASON_POLICY[incoming].deliberate;
}

/** Stream's own words for a person ending the call; anything else Stream sends is `stream_ended`. */
const STREAM_PERSON_END_REASONS = new Set(["call_ended", "end_call"]);

/** Maps a `call.ended` webhook onto the vocabulary; Stream's raw reason is never persisted. */
export function mapStreamCallEndedReason(args: {
  endedBeforeStart: boolean;
  endedByUserId: string | null;
  streamReason?: string | null;
}): MeetingEndReason {
  if (args.endedBeforeStart) return "ended_early";
  if (args.endedByUserId) return "call_ended";
  if (!args.streamReason || STREAM_PERSON_END_REASONS.has(args.streamReason)) {
    return "call_ended";
  }
  return "stream_ended";
}
