/**
 * What happened in one booked session, decided from presence alone.
 *
 * The end + 1 h slot pass in `auto-complete-appointments` is the only writer of
 * the verdict, and the consultation no-show detector reads the same function,
 * so the two jobs never hold different opinions. Its intervals are Stream's
 * settled participant record, stored by `settleOccurrenceAttendance`.
 *
 * The void rule: count the minutes inside the booked window, after the first
 * learner arrived, in which no host-side person (the plan's consultant or any
 * accepted collaborator) was present. A user's devices are merged, reconnect
 * gaps under five minutes (`RECONNECT_GRACE_MINUTES`) are ignored, and minutes
 * that both sides spend together after the booked end (up to 30) are credited
 * back. The session is void when that loss reaches min(15, booked / 2). Minutes
 * the learner lost on their own (late, or left before the host did) never count.
 */

import type { OccurrenceOutcome } from "@prisma/client";

import { endReasonPolicy } from "@/lib/meetings/end-reasons";

export const VOID_LOSS_MINUTES = 15;
export const OVERRUN_CREDIT_MINUTES = 30;
export const EARLY_START_BUFFER_MINUTES = 15;
export const RECONNECT_GRACE_MINUTES = 5;

const MIN_MS = 60_000;

export interface PresenceInterval {
  userId: string;
  joinedAt: Date;
  /** Null while that device is still in the call. */
  leftAt: Date | null;
}

/** A maintenance window or a declared incident; `endsAt` null means still open. */
export interface OutageWindow {
  startsAt: Date;
  endsAt: Date | null;
  /** A declared incident voids every session it overlaps; maintenance only holds a host-absent verdict. */
  source: "maintenance" | "incident";
}

export interface SessionOutcomeInput {
  startsAt: Date;
  endsAt: Date;
  /** The plan's consultant plus every accepted collaborator (D1). */
  hostUserIds: readonly string[];
  intervals: readonly PresenceInterval[];
  meeting: {
    endedAt: Date | null;
    endedReason: string | null;
    endedByUserId?: string | null;
  } | null;
  maintenanceWindows: readonly OutageWindow[];
}

export type OutcomeCompletion = "COMPLETED" | "VOIDED" | "UNVERIFIED";

export interface SessionOutcomeVerdict {
  outcome: OccurrenceOutcome;
  completionStatus: OutcomeCompletion;
  deliveredMinutes: number | null;
  lostMinutes: number | null;
  /** D6 — true only for CUT_SHORT and HOST_ABSENT, which feed the reliability flag. */
  hostAttributed: boolean;
}

/** The completion status each outcome writes (D4, D7). */
export const COMPLETION_FOR_OUTCOME: Record<
  OccurrenceOutcome,
  OutcomeCompletion
> = {
  HELD: "COMPLETED",
  LEARNER_ABSENT: "COMPLETED",
  CUT_SHORT: "VOIDED",
  PLATFORM_OUTAGE: "VOIDED",
  HOST_ABSENT: "VOIDED",
  NOBODY_JOINED: "UNVERIFIED",
  INCONCLUSIVE: "UNVERIFIED",
  OFFLINE: "UNVERIFIED",
};

/** D6 — the voids a host is answerable for. */
export const HOST_ATTRIBUTED_OUTCOMES: readonly OccurrenceOutcome[] = [
  "CUT_SHORT",
  "HOST_ABSENT",
];

type Segment = { start: number; end: number };

function verdict(
  outcome: OccurrenceOutcome,
  delivered: number | null = null,
  lost: number | null = null,
): SessionOutcomeVerdict {
  return {
    outcome,
    completionStatus: COMPLETION_FOR_OUTCOME[outcome],
    deliveredMinutes: delivered,
    lostMinutes: lost,
    hostAttributed: HOST_ATTRIBUTED_OUTCOMES.includes(outcome),
  };
}

/** Clip to the window, then merge overlaps and gaps shorter than the reconnect grace. */
function mergeSide(
  intervals: readonly PresenceInterval[],
  from: number,
  to: number,
): Segment[] {
  const clipped = intervals
    .map((i) => ({
      start: Math.max(i.joinedAt.getTime(), from),
      end: Math.min((i.leftAt ?? i.joinedAt).getTime(), to),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const seg of clipped) {
    const last = merged.at(-1);
    if (last && seg.start - last.end < RECONNECT_GRACE_MINUTES * MIN_MS) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** B4 — minutes one person was in the call inside [from, to], devices merged. */
export function presentMinutes(
  intervals: readonly PresenceInterval[],
  from: Date,
  to: Date,
): number {
  const ms = mergeSide(intervals, from.getTime(), to.getTime()).reduce(
    (sum, s) => sum + (s.end - s.start),
    0,
  );
  return Math.round(ms / MIN_MS);
}

const covers = (segments: Segment[], t: number) =>
  segments.some((s) => s.start <= t && t < s.end);

/** The last departure at or before t, or null when the side never left before t. */
const lastLeftBy = (segments: Segment[], t: number): number | null =>
  segments.reduce<number | null>(
    (acc, s) => (s.end <= t && (acc === null || s.end > acc) ? s.end : acc),
    null,
  );

type MinuteLoss = "host" | "platform" | null;

interface Sides {
  host: Segment[];
  learner: Segment[];
  outages: Segment[];
  /** When a person closed the room ("End for everyone") inside the window. */
  deliberateEndAt: number | null;
}

/** Who lost minute t, when the host side was not in the room. */
function lossAt(sides: Sides, t: number): MinuteLoss {
  if (covers(sides.host, t)) return null;
  if (covers(sides.outages, t)) return "platform";
  if (covers(sides.learner, t)) return "host";
  const grace = RECONNECT_GRACE_MINUTES * MIN_MS;
  const hostLeft = lastLeftBy(sides.host, t);
  const learnerLeft = lastLeftBy(sides.learner, t) ?? t;
  // The host never came while the learner waited, or left first: attributable.
  if (hostLeft === null || learnerLeft - hostLeft > grace) return "host";
  // The learner left first and the host closed an empty room.
  if (Math.abs(learnerLeft - hostLeft) > grace) return null;
  // Everyone left together: a host's "End for everyone" is the host's (D6).
  const endedByHost =
    sides.deliberateEndAt !== null &&
    Math.abs(sides.deliberateEndAt - hostLeft) <= grace;
  return endedByHost ? "host" : "platform";
}

/** Host and platform minutes lost inside [from, booked), in whole minutes. */
function countLoss(sides: Sides, start: number, from: number, booked: number) {
  let hostLoss = 0;
  let platformLoss = 0;
  for (let i = from; i < booked; i++) {
    const loss = lossAt(sides, start + i * MIN_MS + MIN_MS / 2);
    if (loss === "host") hostLoss++;
    else if (loss === "platform") platformLoss++;
  }
  return { hostLoss, platformLoss };
}

/** Pre-start minutes both sides spent together inside [startsAt - 15m, startsAt). */
function earlyStartCredit(sides: Sides, start: number): number {
  let credit = 0;
  for (let i = -EARLY_START_BUFFER_MINUTES; i < 0; i++) {
    const t = start + i * MIN_MS + MIN_MS / 2;
    if (covers(sides.host, t) && covers(sides.learner, t)) credit++;
  }
  return credit;
}

/** Overrun minutes both sides spent together, up to the credit cap. */
function overrunCredit(sides: Sides, start: number, booked: number): number {
  let credit = 0;
  for (let i = booked; i < booked + OVERRUN_CREDIT_MINUTES; i++) {
    const t = start + i * MIN_MS + MIN_MS / 2;
    if (covers(sides.host, t) && covers(sides.learner, t)) credit++;
  }
  return credit;
}

/** The guards that return before any minute is counted. */
function earlyVerdict(
  input: SessionOutcomeInput,
): SessionOutcomeVerdict | null {
  if (!input.meeting) return verdict("OFFLINE");
  // A stay with no leave is never judged; a settled snapshot holds none, so this never moves money.
  if (input.intervals.some((i) => i.leftAt === null)) {
    return verdict("INCONCLUSIVE");
  }
  if (input.intervals.length === 0) return verdict("NOBODY_JOINED");
  // No host side on record (a plan with no consultant): attribution is unknowable.
  if (input.hostUserIds.length === 0) return verdict("INCONCLUSIVE");
  return null;
}

/** Any overlap with the booked interval counts, because ops chose the window. */
export function overlapsDeclaredIncident(
  startsAt: Date,
  endsAt: Date,
  windows: readonly OutageWindow[],
): boolean {
  return windows.some(
    (w) =>
      w.source === "incident" &&
      w.startsAt < endsAt &&
      (w.endsAt === null || w.endsAt > startsAt),
  );
}

/** Pure. See the module comment for the rule; the guards live in `earlyVerdict`. */
export function classifySessionOutcome(
  input: SessionOutcomeInput,
): SessionOutcomeVerdict {
  // A declared incident is the platform's miss: never a forfeit, never a strike.
  if (
    overlapsDeclaredIncident(
      input.startsAt,
      input.endsAt,
      input.maintenanceWindows,
    )
  ) {
    return verdict("PLATFORM_OUTAGE");
  }
  const early = earlyVerdict(input);
  if (early) return early;

  const start = input.startsAt.getTime();
  const end = input.endsAt.getTime();
  const earlyHorizon = start - EARLY_START_BUFFER_MINUTES * MIN_MS;
  const horizon = end + OVERRUN_CREDIT_MINUTES * MIN_MS;
  const hosts = new Set(input.hostUserIds);
  const endedAt = input.meeting?.endedAt?.getTime() ?? null;
  const endedByUserId = input.meeting?.endedByUserId ?? null;
  const isDeliberateHostEnd =
    !!input.meeting?.endedReason &&
    endReasonPolicy(input.meeting.endedReason).money === "host_end" &&
    (endedByUserId === null || hosts.has(endedByUserId));
  const sides: Sides = {
    host: mergeSide(
      input.intervals.filter((i) => hosts.has(i.userId)),
      earlyHorizon,
      horizon,
    ),
    learner: mergeSide(
      input.intervals.filter((i) => !hosts.has(i.userId)),
      earlyHorizon,
      horizon,
    ),
    outages: outageSegments(input),
    deliberateEndAt:
      isDeliberateHostEnd &&
      endedAt !== null &&
      endedAt >= start &&
      endedAt < end
        ? endedAt
        : null,
  };
  const preStartCredit = earlyStartCredit(sides, start);
  const hostEver = sides.host.some(
    (s) => s.start < end && (s.end > start || preStartCredit > 0),
  );
  const learnerEver = sides.learner.some(
    (s) => s.start < end && (s.end > start || preStartCredit > 0),
  );
  if (!learnerEver) {
    return hostEver
      ? verdict("LEARNER_ABSENT", 0, 0)
      : verdict("NOBODY_JOINED");
  }

  const booked = Math.max(1, Math.round((end - start) / MIN_MS));
  const firstInWindowLearner =
    sides.learner.find((s) => s.end > start) ?? sides.learner[0];
  const lossFrom = Math.max(
    0,
    Math.floor((firstInWindowLearner.start - start) / MIN_MS),
  );
  const { hostLoss, platformLoss } = countLoss(sides, start, lossFrom, booked);
  const credit = preStartCredit + overrunCredit(sides, start, booked);
  const lost = Math.max(0, hostLoss + platformLoss - credit);
  const delivered = Math.max(0, booked - lost);
  const isVoid = lost > 0 && lost >= Math.min(VOID_LOSS_MINUTES, booked / 2);

  if (!hostEver) {
    // A host-absent verdict needs a waiting learner and no maintenance hold.
    const held = sides.outages.some((o) => o.start < end && o.end > start);
    return isVoid && !held
      ? verdict("HOST_ABSENT", delivered, lost)
      : verdict("INCONCLUSIVE", delivered, lost);
  }
  if (!isVoid) return verdict("HELD", delivered, lost);
  return platformLoss > hostLoss
    ? verdict("PLATFORM_OUTAGE", delivered, lost)
    : verdict("CUT_SHORT", delivered, lost);
}

/** Maintenance windows, plus a drain that ended this call (an `outage` end reason). */
function outageSegments(input: SessionOutcomeInput): Segment[] {
  const open = Number.MAX_SAFE_INTEGER;
  const segments = input.maintenanceWindows.map((w) => ({
    start: w.startsAt.getTime(),
    end: w.endsAt?.getTime() ?? open,
  }));
  const { meeting } = input;
  if (
    meeting?.endedReason &&
    endReasonPolicy(meeting.endedReason).money === "outage" &&
    meeting.endedAt
  ) {
    segments.push({
      start: meeting.endedAt.getTime() - RECONNECT_GRACE_MINUTES * MIN_MS,
      end: open,
    });
  }
  return segments;
}
