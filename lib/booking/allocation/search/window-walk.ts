// Which 30-minute starts an availability row can host, and the telemetry
// when a walk is cut short.

import * as Sentry from "@sentry/nextjs";
import { ScheduleType } from "@prisma/client";
import { ConsultantAllocationData } from "@/utils/scheduling-engine/types";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import {
  buildAvailabilityIndex,
  indexCoversAtom,
  type AvailabilityInterval,
  type SearchBudget,
} from "@/utils/scheduling-engine/availability-search";
import {
  createWeeklyCoverage,
  partitionWeeklyRows,
  type WeeklyCoverage,
} from "@/utils/schedule/weekly-projection";
import {
  MAX_CANDIDATE_STARTS_PER_ROW,
  type AllocationWalkContext,
  type ProjectableWeeklyRow,
} from "@/lib/booking/allocation/search/constants";

/**
 * Whether a 30-minute candidate sits inside one occurrence of a published
 * row; weekly rows are projected through their own zone, as the validator does.
 */
export function isWithinAvailability(
  candidate: Date,
  consultant: ConsultantAllocationData,
  walk?: AllocationWalkContext,
): boolean {
  if (consultant.scheduleType === ScheduleType.WEEKLY) {
    return weeklyAvailabilityCoverage(consultant, walk).covers(
      candidate.getTime(),
      candidate.getTime() + SCHEDULING_INTERVAL_MS,
    );
  }
  // CUSTOM schedule: the candidate's own atom must fit inside ONE published
  // range. That used to be a linear `.some()` with two `new Date()` per row per
  // call, run once per candidate start × row × day of the window — the reason a
  // consultant with a few hundred published rows could push this past the edge
  // ceiling. The merged index is built once per allocation (below) and then
  // binary-searched, which is exactly equivalent: a contiguous atom lies inside
  // a union of ranges if and only if it lies inside one connected component.
  return indexCoversAtom(
    customAvailabilityIndex(consultant, walk),
    candidate.getTime(),
  );
}

/** The consultant's projectable weekly rows; refused ones are reported by the caller. */
export function projectableWeeklyRows(
  consultant: ConsultantAllocationData,
): ProjectableWeeklyRow[] {
  return partitionWeeklyRows(consultant.availabilityWindowsWeekly).usable;
}

export function weeklyAvailabilityCoverage(
  consultant: ConsultantAllocationData,
  walk?: AllocationWalkContext,
): WeeklyCoverage {
  if (walk?.weeklyCoverage) return walk.weeklyCoverage;
  const coverage = createWeeklyCoverage(projectableWeeklyRows(consultant));
  if (walk) walk.weeklyCoverage = coverage;
  return coverage;
}

/**
 * The consultant's custom rows as one merged interval list, built on first use
 * and then carried on the walk. A walk without a context (a direct unit call)
 * builds it per call, which is what the test that calls the predicate directly
 * asserts about.
 */
export function customAvailabilityIndex(
  consultant: ConsultantAllocationData,
  walk?: AllocationWalkContext,
): AvailabilityInterval[] {
  if (!walk) {
    return buildAvailabilityIndex(consultant.availabilityWindowsCustom);
  }
  if (!walk.customIndex) {
    walk.customIndex = buildAvailabilityIndex(
      consultant.availabilityWindowsCustom,
    );
  }
  return walk.customIndex;
}

/**
 * Every 30-minute start inside one availability row that could host a call.
 *
 * The search used to test only the row's own start instant: a booked 09:00
 * forfeited the entire 09:00-17:00 window and the loop advanced to the next
 * row, so auto-allocate yielded at most one placement per row per week even
 * with seven hours free. Walking the row restores the other fifteen starts.
 *
 * #1194 — the walk is bounded by the ROW'S OWN END (passed by the caller),
 * not just by isWithinAvailability (which adjacent rows keep answering true).
 * MAX_CANDIDATE_STARTS_PER_ROW stays as a safety net: custom rows arrive as
 * day slices, ≤ 25 h in every inhabited zone, so hitting it means a weekly row
 * longer than a day (a legacy shape; writes cap weekly rows at 12 h).
 *
 * The anchor is snapped UP to the booking grid (buyer paths refuse off-grid
 * starts), so an off-grid legacy row 10:15-12:00 yields 10:30, 11:00, 11:30:
 * on-grid and inside the published hours.
 */
export function candidateStartsInRow(
  rowStart: Date,
  consultant: ConsultantAllocationData,
  /**
   * Epoch ms of this row's own end; the walk stops here (#1194). Required —
   * every live caller has the row it is walking, and the optional form was
   * how the ceiling came to silently truncate a legitimate row.
   */
  rowEndMs: number,
  walk?: AllocationWalkContext,
): Date[] {
  const starts: Date[] = [];
  /** Did the ROW (its end, or the edge of availability) stop the walk? */
  let boundedByRow = false;
  const anchorMs =
    Math.ceil(rowStart.getTime() / SCHEDULING_INTERVAL_MS) *
    SCHEDULING_INTERVAL_MS;

  for (let step = 0; step < MAX_CANDIDATE_STARTS_PER_ROW; step++) {
    const candidate = new Date(anchorMs + step * SCHEDULING_INTERVAL_MS);
    // Stop at the row's own end before checking availability — adjacent
    // rows would otherwise let the walk escape past its owner.
    if (candidate.getTime() + SCHEDULING_INTERVAL_MS > rowEndMs) {
      boundedByRow = true;
      break;
    }
    if (!isWithinAvailability(candidate, consultant, walk)) {
      boundedByRow = true;
      break;
    }
    starts.push(candidate);
  }

  // #1194 — the CEILING ended the walk, not the row: a row longer than a
  // day of cover was truncated and its tail is invisible to allocation. The
  // walk used to exit here in silence, so an unallocatable long row looked
  // like "no slots available". Probing the NEXT candidate keeps a row that
  // simply ends at the last allowed start from reporting a truncation it never had.
  if (!boundedByRow) {
    const next = new Date(
      anchorMs + MAX_CANDIDATE_STARTS_PER_ROW * SCHEDULING_INTERVAL_MS,
    );
    if (
      next.getTime() + SCHEDULING_INTERVAL_MS <= rowEndMs &&
      isWithinAvailability(next, consultant, walk)
    ) {
      reportRowWalkTruncated(rowStart, rowEndMs, consultant, walk);
    }
  }

  return starts;
}

/**
 * #1194 — one breadcrumb + one structured warning per truncated row, so a
 * SLOT_SHORTAGE that was really a scan ceiling is attributable to a
 * consultant and an event instead of being indistinguishable from a genuinely
 * full calendar.
 */
export function reportRowWalkTruncated(
  rowStart: Date,
  rowEndMs: number,
  consultant: ConsultantAllocationData,
  walk?: AllocationWalkContext,
): void {
  // One report per row per allocation. A walk with no context (a direct unit
  // call) has no set and still reports, which is what its callers assert on.
  const rowKey = `${rowStart.getTime()}-${rowEndMs}`;
  if (walk?.reportedTruncations) {
    if (walk.reportedTruncations.has(rowKey)) return;
    walk.reportedTruncations.add(rowKey);
  }
  const detail = {
    rowStart: rowStart.toISOString(),
    rowEnd: new Date(rowEndMs).toISOString(),
    cap: MAX_CANDIDATE_STARTS_PER_ROW,
    consultantUserId: consultant.userId,
    consultantProfileId: walk?.consultantProfileId ?? null,
    eventType: walk?.eventType ?? null,
    eventId: walk?.eventId ?? null,
  };
  try {
    Sentry.addBreadcrumb({
      category: "scheduling",
      message: "allocation: availability row hit the candidate-start ceiling",
      level: "warning",
      data: detail,
    });
  } catch {
    // Telemetry must never fail an allocation.
  }
  console.warn(
    "[allocation] availability row truncated at MAX_CANDIDATE_STARTS_PER_ROW",
    detail,
  );
}

/**
 * One breadcrumb per allocation for a search that ran out of its time budget.
 * Without it a budget-truncated walk is indistinguishable from a genuinely full
 * calendar — the SLOT_SHORTAGE it raises is the same one, by design — and the
 * next thing anyone would do is widen the search again.
 */
export function reportSearchBudgetSpent(
  budget: SearchBudget,
  consultant: ConsultantAllocationData,
  walk?: AllocationWalkContext,
): void {
  const detail = {
    budgetMs: budget.limitMs,
    spentMs: budget.spentMs(),
    consultantUserId: consultant.userId,
    consultantProfileId: walk?.consultantProfileId ?? null,
    customRows: consultant.availabilityWindowsCustom.length,
    eventType: walk?.eventType ?? null,
    eventId: walk?.eventId ?? null,
  };
  try {
    Sentry.addBreadcrumb({
      category: "scheduling",
      message: "allocation: availability search hit its time budget",
      level: "warning",
      data: detail,
    });
  } catch {
    // Telemetry must never fail an allocation.
  }
  console.warn("[allocation] availability search hit its time budget", detail);
}
