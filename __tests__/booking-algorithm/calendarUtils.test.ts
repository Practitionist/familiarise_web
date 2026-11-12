/**
 * Comprehensive tests for calendarUtils
 *
 * Covers:
 * - calculateRequiredSlots (delegation to ScheduleCalculationService)
 * - countSundayWeeksInclusive (delegation)
 * - startOfWeekSunday (delegation)
 * - groupSlotsByWeek
 * - validateSlotDistribution
 * - calculateCallProgress
 */

import "./setup";

import {
  calculateRequiredSlots,
  countSundayWeeksInclusive,
  startOfWeekSunday,
  groupSlotsByWeek,
  validateSlotDistribution,
  calculateCallProgress,
  groupSelectedIntoSessions,
  type CalendarInterval,
} from "@/lib/scheduling/calendarUtils";
import {
  makeTimeSlot,
  makeConsecutiveTimeSlots,
} from "../fixtures/booking.mockData";

// ─── calculateRequiredSlots delegation ──────────────────────────────────────

describe("calculateRequiredSlots (calendarUtils wrapper)", () => {
  it("should delegate to ScheduleCalculationService for consultations", () => {
    expect(
      calculateRequiredSlots("consultation", undefined, undefined, 1),
    ).toBe(2);
  });

  it("should delegate to ScheduleCalculationService for subscriptions", () => {
    const result = calculateRequiredSlots(
      "subscription",
      undefined,
      2,
      1,
      new Date("2025-01-06"),
      new Date("2025-01-31"),
    );
    expect(result).toBe(16); // 4 weeks × 2 calls × 2 slots
  });
});

// ─── countSundayWeeksInclusive / startOfWeekSunday delegation ───────────────

describe("Delegated week functions", () => {
  it("countSundayWeeksInclusive should match ScheduleCalculationService", () => {
    expect(
      countSundayWeeksInclusive(new Date("2025-01-06"), new Date("2025-01-31")),
    ).toBe(4);
  });

  it("startOfWeekSunday should return Sunday", () => {
    const result = startOfWeekSunday(new Date("2025-01-08")); // Wednesday
    // UTC weekday — this helper is UTC-based; local getDay() shifts by machine TZ
    expect(result.getUTCDay()).toBe(0);
  });
});

// ─── groupSlotsByWeek ───────────────────────────────────────────────────────

describe("groupSlotsByWeek", () => {
  it("should group slots by week using startOfWeek", () => {
    const slots: CalendarInterval[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00Z",
        "2025-01-06T09:30:00Z",
      ) as CalendarInterval,
      makeTimeSlot(
        "2025-01-13T09:00:00Z",
        "2025-01-13T09:30:00Z",
      ) as CalendarInterval,
    ];

    const grouped = groupSlotsByWeek(slots);
    expect(grouped.size).toBe(2);
  });

  it("should keep same-week slots together", () => {
    const slots: CalendarInterval[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00Z",
        "2025-01-06T09:30:00Z",
      ) as CalendarInterval,
      makeTimeSlot(
        "2025-01-08T09:00:00Z",
        "2025-01-08T09:30:00Z",
      ) as CalendarInterval,
    ];

    const grouped = groupSlotsByWeek(slots);
    expect(grouped.size).toBe(1);
    const weekSlots = Array.from(grouped.values())[0];
    expect(weekSlots.length).toBe(2);
  });
});

// ─── validateSlotDistribution ───────────────────────────────────────────────

describe("validateSlotDistribution", () => {
  it("should pass when slots per week are within limit", () => {
    const slots: CalendarInterval[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00Z",
        "2025-01-06T09:30:00Z",
      ) as CalendarInterval,
      makeTimeSlot(
        "2025-01-13T09:00:00Z",
        "2025-01-13T09:30:00Z",
      ) as CalendarInterval,
    ];

    const result = validateSlotDistribution(slots, 1);
    expect(result.isValid).toBe(true);
  });

  it("should fail when a week exceeds the limit", () => {
    const slots: CalendarInterval[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00Z",
        "2025-01-06T09:30:00Z",
      ) as CalendarInterval,
      makeTimeSlot(
        "2025-01-07T09:00:00Z",
        "2025-01-07T09:30:00Z",
      ) as CalendarInterval,
      makeTimeSlot(
        "2025-01-08T09:00:00Z",
        "2025-01-08T09:30:00Z",
      ) as CalendarInterval,
    ];

    const result = validateSlotDistribution(slots, 2);
    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain("Too many slots");
  });
});

// ─── calculateCallProgress ──────────────────────────────────────────────────

describe("calculateCallProgress", () => {
  it('should return "No slots selected" for empty slots', () => {
    expect(calculateCallProgress([])).toBe("No slots selected");
  });

  it("should count complete calls for 1-hour sessions", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 4); // 4 slots = 2 complete calls
    const result = calculateCallProgress(slots as CalendarInterval[], 1);
    expect(result).toContain("2");
    expect(result).toContain("scheduled");
  });

  it("should count complete calls for 1.5-hour sessions", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 3); // 3 slots = 1 complete 1.5hr call
    const result = calculateCallProgress(slots as CalendarInterval[], 1.5);
    expect(result).toContain("1");
    expect(result).toContain("scheduled");
  });

  it("should warn about incomplete calls", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 1); // 1 slot, need 2 for 1hr
    const result = calculateCallProgress(slots as CalendarInterval[], 1);
    expect(result).toContain("Add");
    expect(result).toContain("more slot");
  });

  it("should show progress with maxTotalCalls", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 2);
    const result = calculateCallProgress(slots as CalendarInterval[], 1, 8);
    expect(result).toContain("1/8");
  });
});

// ─── groupSelectedIntoSessions ──────────────────────────────────────────────
// Footer pre-commit preview: consecutive 30-min atoms collapse into sessions.

describe("groupSelectedIntoSessions", () => {
  const interval = (s: string, e: string): CalendarInterval =>
    makeTimeSlot(s, e) as CalendarInterval;

  it("collapses two consecutive atoms into one session", () => {
    const sessions = groupSelectedIntoSessions([
      interval("2026-11-16T11:00:00Z", "2026-11-16T11:30:00Z"),
      interval("2026-11-16T11:30:00Z", "2026-11-16T12:00:00Z"),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].start.toISOString()).toBe("2026-11-16T11:00:00.000Z");
    expect(sessions[0].end.toISOString()).toBe("2026-11-16T12:00:00.000Z");
  });

  it("splits on a gap and across days", () => {
    const sessions = groupSelectedIntoSessions([
      interval("2026-11-16T11:00:00Z", "2026-11-16T11:30:00Z"),
      interval("2026-11-16T14:00:00Z", "2026-11-16T14:30:00Z"),
      interval("2026-11-17T11:00:00Z", "2026-11-17T11:30:00Z"),
    ]);
    expect(sessions).toHaveLength(3);
  });

  it("sorts unordered input and does not mutate it", () => {
    const b = interval("2026-11-16T11:30:00Z", "2026-11-16T12:00:00Z");
    const a = interval("2026-11-16T11:00:00Z", "2026-11-16T11:30:00Z");
    const input = [b, a];
    const sessions = groupSelectedIntoSessions(input);
    expect(sessions).toHaveLength(1);
    expect(input[0]).toBe(b);
  });

  it("returns [] for an empty selection", () => {
    expect(groupSelectedIntoSessions([])).toEqual([]);
  });

  it("merges a contiguous run", () => {
    const sessions = groupSelectedIntoSessions([
      interval("2026-11-16T18:00:00Z", "2026-11-16T18:30:00Z"),
      interval("2026-11-16T18:30:00Z", "2026-11-16T19:00:00Z"),
    ]);
    expect(sessions).toHaveLength(1);
  });
});
