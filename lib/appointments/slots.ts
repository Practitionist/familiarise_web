/**
 * Shared slot/session time predicates. Single source of truth for the join
 * window — previously duplicated (with different windows and strictness) in
 * the consultee useEventActions hook and the consultant joinState util.
 */

import {
  toDate,
  toDateOrNull,
  type AppointmentKind,
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

/**
 * Slot-derived half of "may this booking be rescheduled".
 *
 * The status, role and route checks genuinely differ per side and stay with
 * their adapter. These three do not, and they drifted: the consultant's menu
 * offered Reschedule on a booking with nothing allocated and on one already
 * awaiting a new time, both of which the API then rejects.
 */
export function slotsAllowReschedule(
  slots: Array<{
    isTentative?: boolean | null;
    completionStatus?: string | null;
  }>,
): boolean {
  // An APPROVED booking with nothing allocated ("Not scheduled · 0/0") has no
  // time to move, and the proposal window is derived from the earliest released
  // session — so this fails with PROPOSAL_WINDOW_CLOSED rather than opening an
  // empty picker.
  if (slots.length === 0) return false;
  // Tentative means the request is still awaiting allocation, not booked.
  if (slots[0]?.isTentative) return false;
  // A released slot awaiting a new time IS the open reschedule: at most one may
  // be live per appointment (the nullable-unique openForAppointmentId), so
  // offering the action again only earns a 409.
  return !slots.some((slot) => slot.completionStatus === "RESCHEDULED");
}

/**
 * Whether Manage Timings may be offered at all — the menu item AND the page,
 * since that URL is linkable (#1082).
 *
 * Manage Timings writes new times straight onto the calendar: no notice
 * requirement, no acceptance from anyone. That is honest only while nobody
 * else has committed to a time, so the deciding question is whether a
 * counterparty already holds one — not who owns the calendar.
 *
 * The exact complement of `slotsAllowReschedule` for the surfaces that offer
 * both, so a consultant is never handed the unilateral surface and the
 * negotiated one for the same booking.
 */
export function allowsManageTimings(
  kind: AppointmentKind,
  slots: Array<{ isTentative?: boolean | null }>,
): boolean {
  // A webinar or class is a published schedule attendees buy into rather than
  // a time anyone negotiated, so the organiser keeps this surface even once
  // the instance is confirmed — there is no single counterparty to propose to,
  // and asking every attendee to accept is not a coherent flow.
  if (kind === "WEBINAR" || kind === "CLASS") return true;
  // Nothing placed: an offering that was never scheduled, or a booking whose
  // sessions are not allocated yet. Still the consultant's own calendar.
  if (slots.length === 0) return true;
  // Tentative means the request is still awaiting allocation, not booked —
  // same reading as slotsAllowReschedule, which refuses on the same test.
  return Boolean(slots[0]?.isTentative);
}

/**
 * The slots a time-change decision acts on: still ahead of now, chronological.
 * A finished session is not what "has someone committed to a time" is asking
 * about, and the first entry has to be the earliest for the tentative test.
 */
export function upcomingSlots<
  T extends { startsAt: Date | string; endsAt: Date | string },
>(slots: T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime();
  return slots
    .filter((slot) => toDate(slot.endsAt).getTime() >= cutoff)
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
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
