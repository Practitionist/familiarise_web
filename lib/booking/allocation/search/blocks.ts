// One call's contiguous 30-minute block from a row, scored by the
// consultee's stated preference.

import { ScheduleType } from "@prisma/client";
import {
  EventType,
  ConsultantAllocationData,
} from "@/utils/scheduling-engine/types";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import {
  maxPreferenceScore,
  scoreCandidateStart,
  type AllocationPreference,
} from "@/utils/scheduling-engine/preferenceScoring";
import type { SearchBudget } from "@/utils/scheduling-engine/availability-search";
import { weeklyRowIntervalsInRange } from "@/utils/schedule/weekly-projection";
import {
  type AllocationWalkContext,
  type ProjectableWeeklyRow,
  type RowSpan,
  DAY_MS,
} from "@/lib/booking/allocation/search/constants";
import { customSpansInStartOrder } from "@/lib/booking/allocation/search/recurrence";
import {
  isWithinAvailability,
  candidateStartsInRow,
  reportSearchBudgetSpent,
} from "@/lib/booking/allocation/search/window-walk";

/**
 * Build one call's worth of back-to-back slots from `start`, or null if the
 * run is interrupted by a booking, the edge of availability, or the past.
 */
export function buildConsecutiveBlock(
  start: Date,
  slotsPerCall: number,
  consultant: ConsultantAllocationData,
  bookedSlots: Set<string>,
  now: Date,
  walk?: AllocationWalkContext,
): Date[] | null {
  const block: Date[] = [];
  let currentTime = new Date(start);

  for (let i = 0; i < slotsPerCall; i++) {
    if (
      bookedSlots.has(currentTime.toISOString()) ||
      !isWithinAvailability(currentTime, consultant, walk) ||
      currentTime < now
    ) {
      return null;
    }
    block.push(new Date(currentTime));
    currentTime = new Date(currentTime.getTime() + SCHEDULING_INTERVAL_MS);
  }

  return block;
}

/**
 * Best-scoring placeable call inside one row on a recurring event's day, or
 * null when the row can host none.
 *
 * A candidate may cross local midnight inside one overnight row, but only
 * onto a day and week whose caps still have room (`hasRoomOn`), so the walk
 * never breaches the per-day cap the validator enforces (ADR B9).
 *
 * #1065 — ordering by preference score, never filtering by it. Every
 * candidate that was placeable before is still placeable; only which of them
 * is returned can change. With no preference the maximum score is 0, the
 * first placeable candidate hits it, and this returns exactly what the old
 * first-fit walk returned.
 */
export function bestFittingBlockInRow(
  rowStart: Date,
  slotsPerCall: number,
  consultant: ConsultantAllocationData,
  bookedSlots: Set<string>,
  /** The clock and the window the placement has to fall inside. */
  bounds: {
    now: Date;
    startDate: Date;
    endDate: Date;
    schedulingTimezone?: string;
    /** Whether the per-day and per-week caps have room at this start. */
    hasRoomOn: (candidateStart: Date) => boolean;
  },
  /** Epoch ms of this row's own end (#1194). */
  rowEndMs: number,
  preference?: AllocationPreference,
  walk?: AllocationWalkContext,
): { block: Date[]; score: number } | null {
  const { now, startDate, endDate, schedulingTimezone, hasRoomOn } = bounds;
  const maxScore = maxPreferenceScore(preference);
  let best: { block: Date[]; score: number } | null = null;

  for (const candidateStart of candidateStartsInRow(
    rowStart,
    consultant,
    rowEndMs,
    walk,
  )) {
    // The whole session must fit, not just its first slot: the validator
    // rejects any slot whose end passes endDate, so testing the start alone
    // would emit a block the validator then throws out.
    const candidateEnd = new Date(
      candidateStart.getTime() + slotsPerCall * SCHEDULING_INTERVAL_MS,
    );

    if (
      candidateStart < now ||
      candidateStart < startDate ||
      candidateEnd > endDate ||
      !hasRoomOn(candidateStart)
    ) {
      continue;
    }

    const block = buildConsecutiveBlock(
      candidateStart,
      slotsPerCall,
      consultant,
      bookedSlots,
      now,
      walk,
    );
    if (!block) continue;

    const score = scoreCandidateStart(
      candidateStart,
      preference,
      schedulingTimezone,
    );
    // Nothing later in the row can beat a perfect match, and an earlier one
    // is the better session anyway — so stop. This is also the no-preference
    // fast path: maxScore is 0, so the first placeable candidate ends the walk.
    if (score >= maxScore) return { block, score };
    if (!best || score > best.score) best = { block, score };
  }

  return best;
}

/**
 * The one block a consultation or webinar needs, or null if the search window
 * holds none.
 *
 * The walk order is unchanged — chronologically sorted rows, week by week,
 * every 30-minute start inside each row. What changed for #1065 is that a
 * placeable block is SCORED and remembered rather than returned outright, and
 * the walk stops early only once a candidate matches the preference in full.
 * With no preference the ceiling is 0, so the very first placeable block ends
 * the walk and this returns precisely what the old first-fit search did.
 *
 * The remembered best is the entire safety property: whatever the preference
 * says, if any block was placeable at all this returns one, so a preference
 * that cannot be met costs a less-liked time and never the allocation.
 *
 * `budget` bounds the row walk only. The remembered best survives a truncated
 * walk, so a search that ran out of time still returns the best block it had
 * found; a truncated walk that found nothing answers SEARCH_TIMEOUT upstream.
 */
export function bestBlockForSingleSession(
  eventType: EventType,
  consultant: ConsultantAllocationData,
  slotsPerCall: number,
  bookedSlots: Set<string>,
  now: Date,
  sortedWeekly: ProjectableWeeklyRow[],
  customRows: ConsultantAllocationData["availabilityWindowsCustom"],
  schedulingTimezone?: string,
  preference?: AllocationPreference,
  walk?: AllocationWalkContext,
  budget?: SearchBudget,
): Date[] | null {
  const maxWeeksToSearch = eventType === "consultation" ? 8 : 4;
  const maxScore = maxPreferenceScore(preference);

  let bestBlock: Date[] | null = null;
  let bestScore = -1;

  /** Row spans in walk order: week-major weekly occurrences, or custom slices by start. */
  const rowStarts: RowSpan[] = [];
  if (consultant.scheduleType === ScheduleType.WEEKLY) {
    // Week-major, row-minor: each row's next `maxWeeksToSearch` occurrences
    // after now, projected per date so a DST change moves the instant, not the wall clock.
    const horizon = new Date(
      now.getTime() + (maxWeeksToSearch * 7 + 1) * DAY_MS,
    );
    const occurrencesByRow = sortedWeekly.map((slot) =>
      // A row still running now keeps its remaining candidates (each one is
      // skipped below if it starts before now), exactly as a custom row does.
      weeklyRowIntervalsInRange(slot, now, horizon)
        .filter((occurrence) => occurrence.end > now)
        .slice(0, maxWeeksToSearch),
    );
    for (let week = 0; week < maxWeeksToSearch; week++) {
      for (const occurrences of occurrencesByRow) {
        const occurrence = occurrences[week];
        if (!occurrence) continue;
        rowStarts.push({
          start: occurrence.start,
          endMs: occurrence.end.getTime(),
        });
      }
    }
  } else {
    // Custom rows as scheduling-zone day slices in start order.
    rowStarts.push(
      ...customSpansInStartOrder(customRows, schedulingTimezone, {
        startMs: now.getTime(),
        endMs: Number.POSITIVE_INFINITY,
      }),
    );
  }

  for (const { start: rowStart, endMs: rowEndMs } of rowStarts) {
    // One row's worth of walk is the unit of work here, so this is the finest
    // place the budget can be tested without putting a clock read inside the
    // candidate loop.
    if (budget?.exhausted()) {
      reportSearchBudgetSpent(budget, consultant, walk);
      break;
    }
    for (const candidateStart of candidateStartsInRow(
      rowStart,
      consultant,
      rowEndMs,
      walk,
    )) {
      if (candidateStart < now) continue;

      const consecutiveBlock = buildConsecutiveBlock(
        candidateStart,
        slotsPerCall,
        consultant,
        bookedSlots,
        now,
        walk,
      );
      if (!consecutiveBlock) continue;

      const score = scoreCandidateStart(
        candidateStart,
        preference,
        schedulingTimezone,
      );
      // A full match cannot be beaten, and the earliest full match is the
      // better session — so stop here rather than scanning the whole window.
      if (score >= maxScore) return consecutiveBlock;
      if (score > bestScore) {
        bestScore = score;
        bestBlock = consecutiveBlock;
      }
    }
  }

  return bestBlock;
}
