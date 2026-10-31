/**
 * The read-side boundary for stored booking times: what a timeline, a list
 * row or the availability grid may assume about an interval by the time it
 * draws one. Pure and Prisma-free so client mappers can call it; server
 * readers hand what it collects to `reportAppointmentAnomalies`.
 *
 * Off-grid times pass through unchanged: a session is drawn where it really
 * is, and grid code snaps to 30-minute atoms on its own.
 */
import { MAX_DURATION_MINUTES } from "@/utils/scheduling-engine/interval-validation";

/** No session outlasts the longest availability window it could sit in. */
export const MAX_SESSION_MS = MAX_DURATION_MINUTES * 60 * 1000;

export type AppointmentAnomalyKind =
  /** A start or end that does not parse as a time. */
  | "UNREADABLE_TIME"
  /** An end at or before its start. */
  | "ENDS_BEFORE_START"
  /** A session longer than `MAX_SESSION_MS`. */
  | "OVERLONG_SESSION"
  /** An approved one-to-one booking that lost every session it had. */
  | "NO_LIVE_SESSION";

/** `id` is the occurrence for a time anomaly, the appointment for a gap. */
export interface AppointmentAnomaly {
  kind: AppointmentAnomalyKind;
  id: string;
}

export type AnomalySink = (anomaly: AppointmentAnomaly) => void;

export interface TimedRow {
  id: string;
  startsAt: Date | string;
  endsAt?: Date | string | null;
}

function instant(value: Date | string | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/** `ms` in the representation `like` uses, so a row read from JSON stays JSON. */
function sameShape(like: Date | string, ms: number): Date | string {
  const at = new Date(ms);
  return typeof like === "string" ? at.toISOString() : at;
}

/**
 * The rows a timeline can draw. A row whose start is unreadable, or whose end
 * is unreadable or not after its start, is dropped; an end more than
 * `MAX_SESSION_MS` after the start is pulled back to that bound. A missing end
 * stays missing, because readers already default it.
 */
export function normalizeOccurrences<T extends TimedRow>(
  rows: readonly T[] | null | undefined,
  sink?: AnomalySink,
): T[] {
  const kept: T[] = [];
  for (const row of rows ?? []) {
    const start = instant(row.startsAt);
    if (!Number.isFinite(start)) {
      sink?.({ kind: "UNREADABLE_TIME", id: row.id });
      continue;
    }
    if (row.endsAt === null || row.endsAt === undefined) {
      kept.push(row);
      continue;
    }
    const end = instant(row.endsAt);
    if (!Number.isFinite(end)) {
      sink?.({ kind: "UNREADABLE_TIME", id: row.id });
      continue;
    }
    if (end <= start) {
      sink?.({ kind: "ENDS_BEFORE_START", id: row.id });
      continue;
    }
    if (end - start > MAX_SESSION_MS) {
      sink?.({ kind: "OVERLONG_SESSION", id: row.id });
      kept.push(
        Object.assign({}, row, {
          endsAt: sameShape(row.endsAt, start + MAX_SESSION_MS),
        }),
      );
      continue;
    }
    kept.push(row);
  }
  return kept;
}

export interface OccupiedInterval {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Occupied time for grid math, clipped to `[range.start, range.end)`. An
 * unreadable or inverted row is dropped, since the database refuses both. An
 * overlong row is kept whole up to the clip, because the overlap constraint
 * still counts all of it; clipping bounds the work to the window drawn.
 */
export function occupiedIntervalsIn(
  rows: Iterable<{
    id: string;
    startsAt: Date | string;
    endsAt: Date | string;
  }>,
  range: { start: Date; end: Date },
  sink?: AnomalySink,
): OccupiedInterval[] {
  const from = range.start.getTime();
  const to = range.end.getTime();
  const intervals: OccupiedInterval[] = [];
  for (const row of rows) {
    const start = instant(row.startsAt);
    const end = instant(row.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      sink?.({ kind: "UNREADABLE_TIME", id: row.id });
      continue;
    }
    if (end <= start) {
      sink?.({ kind: "ENDS_BEFORE_START", id: row.id });
      continue;
    }
    if (end - start > MAX_SESSION_MS) {
      sink?.({ kind: "OVERLONG_SESSION", id: row.id });
    }
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd <= clippedStart) continue;
    intervals.push({
      id: row.id,
      startsAt: new Date(clippedStart),
      endsAt: new Date(clippedEnd),
    });
  }
  return intervals;
}

export type SessionGap = "AWAITING_SCHEDULING" | "NEEDS_RESCHEDULING";

/**
 * What a live booking with nothing on the calendar waits for: a plan with no
 * session placed yet awaits scheduling; a consultation, or anything that had
 * sessions and lost them all, needs a new time. Null while a session is live.
 * Callers decide which statuses count as live bookings.
 */
export function sessionGapOf(args: {
  kind: string | null | undefined;
  rows: number;
  liveRows: number;
}): SessionGap | null {
  if (args.liveRows > 0) return null;
  return args.rows === 0 && args.kind !== "CONSULTATION"
    ? "AWAITING_SCHEDULING"
    : "NEEDS_RESCHEDULING";
}

/** Collects anomalies in order, keeping one per kind and id. */
export function anomalyCollector(): {
  sink: AnomalySink;
  anomalies: () => AppointmentAnomaly[];
} {
  const seen = new Map<string, AppointmentAnomaly>();
  return {
    sink: (anomaly) => {
      const key = `${anomaly.kind}:${anomaly.id}`;
      if (!seen.has(key)) seen.set(key, anomaly);
    },
    anomalies: () => [...seen.values()],
  };
}
