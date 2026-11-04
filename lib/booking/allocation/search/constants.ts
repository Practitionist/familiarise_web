// Bounds and walk context shared by the allocator's availability search.

import { EventType } from "@/utils/scheduling-engine/types";
import type { AvailabilityInterval } from "@/utils/scheduling-engine/availability-search";
import type {
  WeeklyCoverage,
  WeeklyRowLocalColumns,
} from "@/utils/schedule/weekly-projection";

/**
 * Ceiling on the 30-minute starts walked from one availability row.
 *
 * The walk stops at the first candidate outside availability, but adjacent rows
 * make `isWithinAvailability` keep answering true past this row's own end, so a
 * consultant with contiguous cover would otherwise walk the whole week. 50 steps
 * is the longest calendar day (25 hours on a fall-back day), the most one custom
 * day slice can hold, so the cap bounds the scan without truncating a real row.
 */
export const MAX_CANDIDATE_STARTS_PER_ROW = 50;

/**
 * Wall-clock ceiling on one allocation's availability searching (the first
 * search and every re-search around held times share it).
 *
 * The search is O(window × rows) and runs outside the write transaction, so an
 * unbounded walk is the only thing in this path that can cross the ~25 s edge
 * ceiling (a long scheduling period over a consultant with many published rows)
 * — and because the `auto-allocate` grant behind it is a fixed 150 s TTL that is
 * never renewed, an overrun also runs the search unprotected. Ten seconds leaves
 * the rest of the request (the validator read, the write transaction, the
 * notices) its budget; past it the walk stops and answers with the same
 * SLOT_SHORTAGE a full calendar produces, which `allowPartial` already knows how
 * to turn into "place what fits". Mirrors `TOP_UP_TIME_BUDGET_MS`
 * (scripts/appointments/reconcile-occurrence-availability.ts).
 */
export const ALLOCATOR_SEARCH_TIME_BUDGET_MS = 10_000;

/**
 * #1194 — who is being scheduled, carried down the row walk so a truncated
 * availability row names a consultant and an event instead of appearing as an
 * anonymous "no slots available".
 */
export interface AllocationWalkContext {
  eventType: EventType;
  eventId?: string;
  consultantProfileId?: string;
  /**
   * Rows already reported as truncated on THIS allocation. The walk re-visits
   * a row once per day, and again after every placement, so without this one
   * long row emits hundreds of identical warnings and evicts every other
   * breadcrumb on the Sentry scope — losing the context the report exists for.
   */
  reportedTruncations?: Set<string>;
  /**
   * The merged custom-availability index, built on first use. Keyed by object
   * identity because `fetchEventData` mints a fresh consultant per allocation:
   * the index can never outlive the rows it was built from, and the scan it
   * replaces ran once per candidate.
   */
  customIndex?: AvailabilityInterval[];
  /** The weekly rows' projected occurrences, built on first use like `customIndex`. */
  weeklyCoverage?: WeeklyCoverage;
}

/** One span of availability the row walk can host calls in: its start and its exclusive end. */
export type RowSpan = { start: Date; endMs: number };

/** A weekly row the allocator can project. */
export type ProjectableWeeklyRow = { id: string } & WeeklyRowLocalColumns;

export const DAY_MS = 24 * 60 * 60 * 1000;
