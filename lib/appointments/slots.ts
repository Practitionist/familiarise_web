/**
 * Shared slot/session time predicates. Single source of truth for the join
 * window — previously duplicated (with different windows and strictness) in
 * the consultee useEventActions hook and the consultant joinState util.
 */

import {
  toDate,
  toDateOrNull,
  type SessionVM,
  type SlotLike,
} from "./view-model";

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

/** Consultee join window (pre-start). */
export const CONSULTEE_JOIN_WINDOW_MS = 10 * 60 * 1000;
/** Consultant join window (pre-start) — hosts get in earlier to set up. */
export const CONSULTANT_JOIN_WINDOW_MS = 15 * 60 * 1000;

export type SlotJoinState = "disabled" | "countdown" | "joinable" | "ended";

const DEAD_COMPLETION_STATUSES = new Set(["CANCELLED", "RESCHEDULED"]);

export function isDeadSlot(slot: {
  completionStatus?: string | null;
}): boolean {
  return (
    !!slot.completionStatus &&
    DEAD_COMPLETION_STATUSES.has(slot.completionStatus)
  );
}

function slotTimes(slot: SlotLike): { start: number; end: number } {
  const start = toDate(slot.startsAt).getTime();
  const endsAt = toDateOrNull(slot.endsAt ?? null);
  return {
    start,
    end: endsAt ? endsAt.getTime() : start + DEFAULT_MEETING_DURATION_MS,
  };
}

export function getSlotJoinState(
  slot: SlotLike,
  opts?: { joinWindowMs?: number; now?: Date },
): SlotJoinState {
  if (slot.isTentative) return "disabled";
  if (isDeadSlot(slot)) return "disabled";
  // Session manually ended early by the host.
  if (toDateOrNull(slot.meetingSession?.endedAt ?? null)) return "ended";

  const joinWindowMs = opts?.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const now = (opts?.now ?? new Date()).getTime();
  const { start, end } = slotTimes(slot);

  if (now > end) return "ended";
  if (now >= start - joinWindowMs) return "joinable";
  return "countdown";
}

/** Earliest slot currently inside its join window, or null. */
export function getJoinableSlot<T extends SlotLike>(
  slots: T[],
  opts?: { joinWindowMs?: number; now?: Date },
): T | null {
  const sorted = [...slots].sort(
    (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
  );
  for (const slot of sorted) {
    if (getSlotJoinState(slot, opts) === "joinable") return slot;
  }
  return null;
}

function sessionEnd(session: SessionVM): number {
  if (session.meetingEndedAt) return session.meetingEndedAt.getTime();
  return session.endsAt
    ? session.endsAt.getTime()
    : session.startsAt.getTime() + DEFAULT_MEETING_DURATION_MS;
}

/** Sessions that still count (not cancelled/rescheduled away). */
export function activeSessions(sessions: SessionVM[]): SessionVM[] {
  return sessions.filter((s) => !isDeadSlot(s));
}

export function isSessionOver(session: SessionVM, now = new Date()): boolean {
  return sessionEnd(session) < now.getTime();
}

/** True when the timeline has sessions and every active one is over. */
export function allSessionsOver(
  sessions: SessionVM[],
  now = new Date(),
): boolean {
  const active = activeSessions(sessions);
  if (sessions.length === 0) return false;
  if (active.length === 0) return true;
  return active.every((s) => isSessionOver(s, now));
}

/**
 * Day-group / sort anchor: the next active session that hasn't ended, else
 * the most recent active session (so past rows group under their real date).
 */
export function getAnchorTime(
  sessions: SessionVM[],
  now = new Date(),
): Date | null {
  const active = activeSessions(sessions);
  if (active.length === 0) return null;
  const upcoming = active.find((s) => !isSessionOver(s, now));
  return upcoming?.startsAt ?? active[active.length - 1]?.startsAt ?? null;
}

/**
 * Short human proximity label for an upcoming anchor ("in 45 min", "Today",
 * "Tomorrow", "in 5 days"). Returns null for past/absent anchors — rows show
 * the absolute time regardless; this is the urgency accent next to it.
 */
export function getProximityLabel(
  anchor: Date | null,
  now = new Date(),
): string | null {
  if (!anchor) return null;
  const diffMs = anchor.getTime() - now.getTime();
  if (diffMs <= 0) return null;

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `in ${Math.max(diffMinutes, 1)} min`;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Math.round, not floor: across a DST boundary a "day" between local
  // midnights is 23/25h and floor would undercount it.
  const dayDiff = Math.round(
    (new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate(),
    ).getTime() -
      todayStart.getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff < 7) return `in ${dayDiff} days`;
  const weeks = Math.ceil(dayDiff / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}
