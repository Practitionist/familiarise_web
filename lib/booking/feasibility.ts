/**
 * Can a plan's cadence actually be delivered from the expert's published hours?
 *
 * The allocator only discovers an impossible plan after money moved (409/400
 * `SLOT_SHORTAGE`, `NO_AVAILABILITY`). This module answers the same question up
 * front, from the same inputs the allocator reads: published weekly or custom
 * rows projected in their own zone, minus the time already held, on the UTC
 * half-hour lattice, one session per start day up to the per-day cap.
 *
 * It is deliberately conservative in one direction only: a session that would
 * cross the scheduling zone's midnight is not counted, so a verdict of "ok" is
 * never optimistic. Spacing is ignored, because the allocator packs when it
 * cannot space.
 */

import type { Tx } from "@/lib/prisma";
import { dayStartInstant } from "@/lib/time/grid-zone";
import { customRowDaySlices } from "@/lib/booking/allocation/search/recurrence";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { WEEKLY_COVERAGE_SELECT } from "@/utils/scheduling-engine/availabilityCoverage";
import {
  buildDeadHoldFilter,
  OCCUPYING_OCCURRENCE_WHERE,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  partitionWeeklyRows,
  weeklyRowIntervalsInRange,
} from "@/utils/schedule/weekly-projection";

const ATOM_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Weeks below this multiple of the weekly cadence are "tight": one busy week breaks them. */
export const FEASIBILITY_HEADROOM = 1.25;

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

export interface FeasibilityInput {
  /** Published hours as absolute spans (weekly rows already projected, custom rows as stored). */
  windows: TimeSpan[];
  /** Time the expert already holds (confirmed sessions and live holds). */
  busy: TimeSpan[];
  /** The plan's scheduling zone: days and weeks are cut on its midnights. */
  zone: string;
  sessionMinutes: number;
  sessionsPerWeek: number;
  perDayCap: number;
  /** Earliest instant a session may start (now plus the purpose's lead time). */
  notBeforeMs: number;
  /** Plan weeks to assess, each seven zone-days from `notBeforeMs`'s zone-day. */
  weeks: number;
}

export interface WeekCapacity {
  /** First instant of the week's first zone-day. */
  weekStartMs: number;
  /** Sessions that fit this week ignoring existing bookings, capped by the cadence. */
  publishedCapacity: number;
  /** Sessions that fit this week around existing bookings, capped by the cadence. */
  placeable: number;
}

export type FeasibilityReasonCode =
  | "NO_AVAILABILITY"
  | "SESSION_LONGER_THAN_WINDOWS"
  | "TOO_FEW_OPEN_HOURS"
  | "WEEKS_SHORT"
  | "LOW_HEADROOM";

export interface FeasibilityReason {
  code: FeasibilityReasonCode;
  /** Plain-language explanation for the expert; buyer copy is derived separately. */
  message: string;
}

export type FeasibilityVerdict = "impossible" | "tight" | "ok";

export interface FeasibilityReport {
  verdict: FeasibilityVerdict;
  weeks: WeekCapacity[];
  /** The longest single published window, in minutes (0 with none). */
  longestWindowMinutes: number;
  /** The best week's capacity from published hours alone, uncapped by the cadence. */
  bestWeekPublishedSessions: number;
  reasons: FeasibilityReason[];
}

const ceilAtom = (ms: number) => Math.ceil(ms / ATOM_MS) * ATOM_MS;
const floorAtom = (ms: number) => Math.floor(ms / ATOM_MS) * ATOM_MS;

/** Merge overlapping or touching spans; input order does not matter. */
export function mergeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const sorted = spans
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: TimeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** `free` minus `busy`, both merged first. */
export function subtractSpans(
  free: readonly TimeSpan[],
  busy: readonly TimeSpan[],
): TimeSpan[] {
  const taken = mergeSpans(busy);
  const out: TimeSpan[] = [];
  for (const span of mergeSpans(free)) {
    let cursor = span.startMs;
    for (const block of taken) {
      if (block.endMs <= cursor || block.startMs >= span.endMs) continue;
      if (block.startMs > cursor) {
        out.push({ startMs: cursor, endMs: block.startMs });
      }
      cursor = Math.max(cursor, block.endMs);
      if (cursor >= span.endMs) break;
    }
    if (cursor < span.endMs) out.push({ startMs: cursor, endMs: span.endMs });
  }
  return out;
}

/** Whole sessions that fit back to back inside the spans, on the half-hour lattice. */
function sessionsIn(spans: readonly TimeSpan[], sessionMs: number): number {
  let count = 0;
  for (const span of spans) {
    const start = ceilAtom(span.startMs);
    const end = floorAtom(span.endMs);
    if (end > start) count += Math.floor((end - start) / sessionMs);
  }
  return count;
}

function clip(
  spans: readonly TimeSpan[],
  from: number,
  to: number,
): TimeSpan[] {
  const out: TimeSpan[] = [];
  for (const span of spans) {
    const startMs = Math.max(span.startMs, from);
    const endMs = Math.min(span.endMs, to);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  return out;
}

/** The first instant of each zone-day from `fromMs`'s day, `count + 1` boundaries. */
export function zoneDayBoundaries(
  fromMs: number,
  zone: string,
  count: number,
): number[] {
  const [year, month, day] = ScheduleCalculationService.dayKey(
    new Date(fromMs),
    zone,
  )
    .split("-")
    .map(Number);
  const boundaries: number[] = [];
  for (let offset = 0; offset <= count; offset += 1) {
    // A local-noon date names the calendar day; dayStartInstant reads its fields.
    boundaries.push(
      dayStartInstant(
        new Date(year, month - 1, day + offset, 12),
        zone,
      ).getTime(),
    );
  }
  return boundaries;
}

/**
 * The pure assessment. Each zone-day contributes at most `perDayCap` sessions;
 * each week at most `sessionsPerWeek`. "impossible" means no week can ever hold
 * the cadence from published hours alone; "tight" means some assessed week
 * cannot around today's bookings, or the best week has little headroom.
 */
export function assessFeasibility(input: FeasibilityInput): FeasibilityReport {
  const sessionMs = input.sessionMinutes * 60_000;
  const windows = mergeSpans(input.windows);
  const free = subtractSpans(windows, input.busy);
  const days = zoneDayBoundaries(
    input.notBeforeMs,
    input.zone,
    input.weeks * 7,
  );

  const longestWindowMinutes = windows.reduce(
    (longest, span) =>
      Math.max(
        longest,
        (floorAtom(span.endMs) - ceilAtom(span.startMs)) / 60_000,
      ),
    0,
  );

  const weeks: WeekCapacity[] = [];
  let bestWeekPublishedSessions = 0;
  for (let week = 0; week < input.weeks; week += 1) {
    let published = 0;
    let placeable = 0;
    for (let d = week * 7; d < week * 7 + 7; d += 1) {
      const dayFrom = Math.max(days[d], input.notBeforeMs);
      const dayTo = days[d + 1];
      if (dayTo <= dayFrom) continue;
      published += Math.min(
        input.perDayCap,
        sessionsIn(clip(windows, dayFrom, dayTo), sessionMs),
      );
      placeable += Math.min(
        input.perDayCap,
        sessionsIn(clip(free, dayFrom, dayTo), sessionMs),
      );
    }
    bestWeekPublishedSessions = Math.max(bestWeekPublishedSessions, published);
    weeks.push({
      weekStartMs: days[week * 7],
      publishedCapacity: Math.min(input.sessionsPerWeek, published),
      placeable: Math.min(input.sessionsPerWeek, placeable),
    });
  }

  const reasons: FeasibilityReason[] = [];
  if (windows.length === 0) {
    reasons.push({
      code: "NO_AVAILABILITY",
      message: "No availability is published, so no session can be placed.",
    });
  } else if (longestWindowMinutes < input.sessionMinutes) {
    reasons.push({
      code: "SESSION_LONGER_THAN_WINDOWS",
      message: `Each session is ${input.sessionMinutes} minutes, but the longest published window is ${longestWindowMinutes} minutes.`,
    });
  } else if (bestWeekPublishedSessions < input.sessionsPerWeek) {
    reasons.push({
      code: "TOO_FEW_OPEN_HOURS",
      message: `The plan needs ${input.sessionsPerWeek} sessions a week (at most ${input.perDayCap} a day), but the published hours fit at most ${bestWeekPublishedSessions} in any week.`,
    });
  }
  if (reasons.length > 0) {
    return {
      verdict: "impossible",
      weeks,
      longestWindowMinutes,
      bestWeekPublishedSessions,
      reasons,
    };
  }

  const shortWeeks = weeks.filter(
    (week) => week.placeable < input.sessionsPerWeek,
  ).length;
  if (shortWeeks > 0) {
    reasons.push({
      code: "WEEKS_SHORT",
      message: `${shortWeeks} of the next ${weeks.length} weeks can't fit ${input.sessionsPerWeek} sessions around existing bookings.`,
    });
  }
  if (
    bestWeekPublishedSessions <
    Math.ceil(input.sessionsPerWeek * FEASIBILITY_HEADROOM)
  ) {
    reasons.push({
      code: "LOW_HEADROOM",
      message: `The published hours fit only ${bestWeekPublishedSessions} sessions in the best week, so one busy day can leave a week short.`,
    });
  }
  return {
    verdict: reasons.length > 0 ? "tight" : "ok",
    weeks,
    longestWindowMinutes,
    bestWeekPublishedSessions,
    reasons,
  };
}

/** Sessions the first assessed week can hold around existing bookings. */
export function firstWeekPlaceable(report: FeasibilityReport): number {
  return report.weeks[0]?.placeable ?? 0;
}

/** The buyer-facing notice, or null when the plan fits comfortably. */
export function buyerFeasibilityNotice(
  report: FeasibilityReport,
  sessionsPerWeek: number,
): string | null {
  if (report.verdict === "ok") return null;
  const typical = Math.min(
    sessionsPerWeek,
    ...report.weeks.map((week) => week.placeable),
  );
  if (typical >= sessionsPerWeek) return null;
  return `This expert currently has room for about ${typical} of ${sessionsPerWeek} sessions a week. Sessions that can't be scheduled before the plan ends are refunded.`;
}

/** The published rows and held time for one expert over a range, as spans. */
export async function readFeasibilitySpans(
  db: Pick<Tx, "consultantProfile" | "appointmentOccurrence">,
  consultantProfileId: string,
  range: { fromMs: number; toMs: number },
  now: Date = new Date(),
): Promise<{ windows: TimeSpan[]; busy: TimeSpan[] }> {
  const from = new Date(range.fromMs);
  const to = new Date(range.toMs);
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      scheduleType: true,
      availabilityWindowsWeekly: { select: WEEKLY_COVERAGE_SELECT },
      availabilityWindowsCustom: {
        where: { endsAt: { gt: from }, startsAt: { lt: to } },
        select: { startsAt: true, endsAt: true },
      },
    },
  });
  if (!profile) return { windows: [], busy: [] };

  const windows: TimeSpan[] = [];
  // ScheduleType is exclusive: the dormant arm publishes nothing.
  if (profile.scheduleType === "WEEKLY") {
    const weekly = partitionWeeklyRows(profile.availabilityWindowsWeekly);
    reportIncompleteWeeklyRows(weekly.refused, {
      op: "feasibility",
      consultantProfileId,
    });
    for (const row of weekly.usable) {
      for (const interval of weeklyRowIntervalsInRange(row, from, to)) {
        windows.push({
          startMs: interval.start.getTime(),
          endMs: interval.end.getTime(),
        });
      }
    }
  } else {
    for (const row of profile.availabilityWindowsCustom) {
      for (const slice of customRowDaySlices(row)) {
        windows.push({ startMs: slice.start.getTime(), endMs: slice.endMs });
      }
    }
  }

  const held = await db.appointmentOccurrence.findMany({
    where: {
      consultantProfileId,
      ...OCCUPYING_OCCURRENCE_WHERE,
      endsAt: { gt: from },
      startsAt: { lt: to },
      appointment: { deletedAt: null, NOT: buildDeadHoldFilter(now) },
    },
    select: { startsAt: true, endsAt: true },
  });
  const busy = held.map((row) => ({
    startMs: row.startsAt.getTime(),
    endMs: row.endsAt.getTime(),
  }));
  return { windows: clip(windows, range.fromMs, range.toMs), busy };
}

/** Read and assess in one call: the shape every caller (editor, checkout, tray) uses. */
export async function assessExpertFeasibility(
  db: Pick<Tx, "consultantProfile" | "appointmentOccurrence">,
  params: Omit<FeasibilityInput, "windows" | "busy"> & {
    consultantProfileId: string;
    /** Plan editing ignores today's bookings; a buyer's checkout counts them. */
    countBookings: boolean;
  },
  now: Date = new Date(),
): Promise<FeasibilityReport> {
  const toMs = params.notBeforeMs + (params.weeks * 7 + 1) * DAY_MS;
  const spans = await readFeasibilitySpans(
    db,
    params.consultantProfileId,
    { fromMs: params.notBeforeMs - DAY_MS, toMs },
    now,
  );
  return assessFeasibility({
    ...params,
    windows: spans.windows,
    busy: params.countBookings ? spans.busy : [],
  });
}

/** Plan weeks the editor checks: four is the roll-forward horizon the plan is sold against. */
export const PLAN_FEASIBILITY_WEEKS = 4;

export interface PlanFeasibilityRefusal {
  status: 422;
  body: {
    error: string;
    code: "PLAN_NOT_FEASIBLE";
    reasons: FeasibilityReason[];
  };
}

export interface PlanFeasibilityOutcome {
  /** Set when a PUBLISHED plan can never be delivered: answer 422 and save nothing. */
  refusal: PlanFeasibilityRefusal | null;
  /** Shown to the expert on save when the plan is deliverable but brittle (or still a draft). */
  warnings: FeasibilityReason[];
}

/**
 * The plan editor's gate. A published plan whose cadence no week of the
 * expert's published hours can hold is refused with 422 `PLAN_NOT_FEASIBLE`;
 * a draft is saved with the same reasons as warnings, so an expert can author
 * a plan before publishing hours. Existing bookings are not counted: they move
 * week to week, while the published hours are what the plan is sold against.
 */
export async function planPublishFeasibility(
  db: Pick<Tx, "consultantProfile" | "appointmentOccurrence">,
  params: {
    consultantProfileId: string;
    sessionsPerWeek: number;
    sessionMinutes: number;
    perDayCap: number;
    publishing: boolean;
  },
  now: Date = new Date(),
): Promise<PlanFeasibilityOutcome> {
  const owner = await db.consultantProfile.findUnique({
    where: { id: params.consultantProfileId },
    select: { user: { select: { timezone: true } } },
  });
  const report = await assessExpertFeasibility(
    db,
    {
      consultantProfileId: params.consultantProfileId,
      zone: resolveSchedulingTimezone(owner?.user?.timezone),
      sessionMinutes: params.sessionMinutes,
      sessionsPerWeek: params.sessionsPerWeek,
      perDayCap: params.perDayCap,
      notBeforeMs: now.getTime(),
      weeks: PLAN_FEASIBILITY_WEEKS,
      countBookings: false,
    },
    now,
  );
  if (report.verdict === "impossible" && params.publishing) {
    return {
      refusal: {
        status: 422,
        body: {
          error:
            "This plan can't be delivered from your published availability. " +
            report.reasons.map((reason) => reason.message).join(" ") +
            " Add hours, shorten the sessions or lower the sessions a week, or save it as a draft.",
          code: "PLAN_NOT_FEASIBLE",
          reasons: report.reasons,
        },
      },
      warnings: [],
    };
  }
  return { refusal: null, warnings: report.reasons };
}
