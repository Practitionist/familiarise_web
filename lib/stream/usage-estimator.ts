/**
 * Stream usage estimator — the Postgres half of issue #1134 E5.
 *
 * Runs nightly. Produces the two figures that CANNOT be read from a Stream API
 * call and cost nothing to compute, because we already store the inputs:
 *
 *   participantMinutes   Σ over `MeetingAttendance` rows in the trailing 30 days
 *                        of (end − firstJoinedAt), where `end` is `lastLeftAt`,
 *                        else the meeting's `endedAt`, else NOW.
 *   peakConcurrency      The largest number of those intervals overlapping at
 *                        any single instant in the window.
 *
 * ## Both numbers are UPPER BOUNDS, deliberately
 *
 * That is the correct direction for a ceiling alarm and the wrong direction for
 * an invoice reconciliation, and this file is only ever the first. Stream bills
 * participant-minutes at the AGGREGATED RECEIVED resolution — which Stream
 * states it cannot cap — so the true cost is ≥ the minute count we can compute,
 * and a meeting that ran without anyone ever leaving is counted to now rather
 * than to its true end. Both biases push the number UP, which is what you want
 * from something whose job is to say "the cap is closer than it looks".
 *
 * Said plainly in the snapshot's own `estimated` flag and on the health route,
 * so nobody later mistakes this for Stream's invoice.
 *
 * ## Peak concurrency is an ESTIMATE from intervals, not a sample
 *
 * There is no per-minute occupancy series in the database — `MeetingPresence`
 * stores per-device join/leave intervals, which is the same information at a
 * finer grain, but a 30-day sweep of that table is a different order of
 * magnitude of work and a different set of indexes. The sweep-line below is
 * exact GIVEN the intervals it is given: it sorts every interval by start and
 * advances a single cursor, so it is O(n log n) with no sampling and no
 * bucketing error. What it cannot know is occupancy between a `firstJoinedAt`
 * and a missing `lastLeftAt`, which is the same upper-bound bias as above.
 *
 * ## Why it is bounded, and what happens when the bound bites
 *
 * The row fetch is capped ({@link MAX_ATTENDANCE_ROWS}). A platform that ran
 * 30 days of large webinars can exceed it, and the cap is a deliberate refusal
 * to let a nightly job hold a Postgres connection open for minutes — which with
 * `PG_POOL_MAX=1` is a platform-wide stall, not just a slow job.
 *
 * When the cap bites, the oldest rows are dropped (ordered `firstJoinedAt desc`,
 * so what survives is the most recent activity) and `estimated: true` is set, so
 * the figure is reported as the lower bound it has become. Silence there would
 * be the one genuinely bad outcome: a quietly under-counted bill ceiling is
 * worse than a loud wrong one, because the alarm would not fire.
 */

import prisma from "@/lib/prisma";
import { reportSentryMessage } from "@/lib/observability/report";
import {
  alertStreamUsage,
  readStreamUsage,
  writeStreamUsageSnapshot,
  type StreamUsageSnapshot,
} from "@/lib/stream/usage";

/** Stream bills MAU and video over a monthly window. */
const WINDOW_DAYS = 30;

/**
 * Cap on attendance rows pulled in one run.
 *
 * 20,000 rows at ~60 bytes each is a small result set, and the sweep-line
 * below is O(n log n) in memory. The cap exists to bound the QUERY and the
 * connection hold, not the arithmetic. Reaching it is reported, not hidden.
 */
const MAX_ATTENDANCE_ROWS = 20_000;

const MINUTE_MS = 60_000;

interface Interval {
  start: number;
  end: number;
}

/**
 * Largest number of intervals overlapping at any instant, and the total
 * interval-minutes, in one sweep.
 *
 * Classic sweep line: one pass sorted by start, carrying the end times of
 * everything currently open in a min-heap, so `peak` is the maximum heap size
 * and `minutes` is the sum of each interval's own length. The heap is small
 * (only the currently-overlapping intervals) and is rebuilt per run, so there is
 * no state to leak between nights.
 */
/**
 * Peak concurrency and summed minutes over a set of intervals.
 *
 * Exported for the unit test that pins the sweep-line invariant below. It is
 * pure and takes its data as an argument, so there is no reason for the shape to
 * be private — and the bug it had (an unsorted `open` array) lived precisely
 * because the only way to exercise it was through the database.
 */
export function sweepIntervals(intervals: Interval[]): {
  peak: number;
  minutes: number;
} {
  if (intervals.length === 0) return { peak: 0, minutes: 0 };

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  // `open` is kept sorted ascending; the first entry is the earliest end.
  const open: number[] = [];
  let peak = 0;
  let minutes = 0;

  for (const { start, end } of sorted) {
    // Retire everything that ended at or before this start. `<=` rather than
    // `<` so two intervals that merely TOUCH are not counted as overlapping:
    // a participant leaving exactly as another joins is not a second
    // simultaneous participant, and over-counting concurrency here would inflate
    // the figure for no reason.
    while (open.length > 0 && open[0] <= start) open.shift();

    // #1829 — `open` must stay SORTED, and it was not. Intervals arrive sorted by
    // START, which says nothing about their ends, so a plain `push` could leave
    // a short interval stranded behind a long one:
    //
    //   A [0,100]  B [1,2]  C [50,60]
    //   C starts → open is [100, 2] → open[0] is 100, which is > 50, so
    //   nothing is retired, and peak is read as 3. The true peak is 2.
    //
    // The comment above this loop claimed `open` was kept ascending, so the bug
    // was invisible in review — the code and its own description disagreed, and
    // the description was the correct one.
    //
    // Insert in position rather than sort the whole array each time: this loop
    // runs once per attendance interval and the array is bounded by the
    // concurrency actually observed, so a linear insert from the back is cheaper
    // than an O(n log n) re-sort and does not churn the array.
    let at = open.length;
    while (at > 0 && open[at - 1] > end) at--;
    open.splice(at, 0, end);
    if (open.length > peak) peak = open.length;

    // A zero/negative length is possible (a webhook that closed the row before
    // it opened one, or clock skew between the join and leave events). Clamped:
    // a negative contribution to a bill is a bug in the estimator, and the bias
    // must stay upward.
    minutes += Math.max(0, end - start) / MINUTE_MS;
  }

  return { peak, minutes: Math.round(minutes) };
}

export interface StreamUsageEstimate {
  snapshot: StreamUsageSnapshot;
  /** Rows the cap refused to look at. Non-zero means the figure is a floor. */
  droppedRows: number;
  /** Attendance rows in the window before the cap. */
  examinedRows: number;
}

/**
 * Compute the snapshot. Exported separately from the runner so a test can pin
 * the arithmetic without Redis, Sentry or a database.
 */
export async function estimateStreamUsage(
  now: Date = new Date(),
): Promise<StreamUsageEstimate> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.meetingAttendance.findMany({
    where: { firstJoinedAt: { gte: since } },
    orderBy: { firstJoinedAt: "desc" },
    take: MAX_ATTENDANCE_ROWS + 1,
    select: {
      firstJoinedAt: true,
      lastLeftAt: true,
      meeting: { select: { endedAt: true } },
    },
  });

  const droppedRows = Math.max(0, rows.length - MAX_ATTENDANCE_ROWS);
  const examined = rows.slice(0, MAX_ATTENDANCE_ROWS);
  const nowMs = now.getTime();

  const intervals: Interval[] = examined.map((row) => {
    // End preference, in order: the participant's own leave, then the session's
    // end (a participant who never left a call that did), then now (a call still
    // open, or a participant who never left one that never ended).
    const endMs = row.lastLeftAt
      ? row.lastLeftAt.getTime()
      : row.meeting.endedAt
        ? row.meeting.endedAt.getTime()
        : nowMs;
    return {
      start: row.firstJoinedAt.getTime(),
      end: Math.max(endMs, row.firstJoinedAt.getTime()),
    };
  });

  const { peak, minutes } = sweepIntervals(intervals);

  // MAU is NOT computed here — it lives in Redis, incremented on the token-mint
  // path (see `noteStreamTokenMint`). Read at write time so the snapshot and
  // the live counter agree, with the live counter winning.
  const live = await readStreamUsage();
  const mau = live.snapshot?.mau ?? 0;

  return {
    snapshot: {
      mau,
      participantMinutes: minutes,
      peakConcurrency: peak,
      computedAt: now.toISOString(),
      estimated: droppedRows > 0,
    },
    droppedRows,
    examinedRows: examined.length,
  };
}

/**
 * Compute, persist, and alarm. Returns the snapshot so both the job entry point
 * and the HTTP twin can log the same shape.
 */
export async function runStreamUsageMeter(): Promise<StreamUsageEstimate> {
  const estimate = await estimateStreamUsage();

  await writeStreamUsageSnapshot(estimate.snapshot);

  // Read back rather than reusing the object in hand: the write is what the
  // health route will serve, so the alarm is raised against the number an
  // operator will actually see, with the live MAU counter folded in.
  const report = await readStreamUsage();
  alertStreamUsage(report);

  if (estimate.droppedRows > 0) {
    // Loud, and separately from the threshold alarm: a truncated estimate is a
    // defect in the meter, not a fact about usage, and the two must not be
    // conflated in one message an operator has to disambiguate.
    reportSentryMessage(
      `Stream usage estimator hit its ${MAX_ATTENDANCE_ROWS}-row cap and dropped ` +
        `${estimate.droppedRows} attendance rows; participantMinutes is a FLOOR for this run, not an estimate.`,
      {
        subsystem: "stream",
        op: "usage.estimate",
        level: "warning",
        tags: { reason: "stream.usage_truncated" },
        extra: { droppedRows: estimate.droppedRows },
      },
    );
  }

  return estimate;
}
