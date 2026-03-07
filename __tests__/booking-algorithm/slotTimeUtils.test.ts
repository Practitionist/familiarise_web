/**
 * Tests for slotTimeUtils
 *
 * Covers:
 * - isMinuteWithinWeeklySlot: timezone day-shift (TEST-1), overnight slots (TEST-3)
 * - minutesToTimeString / timeStringToMinutes: round-trip
 * - validateWeeklySlotTimeOrder: same-day and overnight validation
 * - slotsOverlap: same-day and overnight overlap detection
 * - getTimezoneOffsetMinutes: range validation (MED-2)
 */

import "./setup";

import {
  minutesToTimeString,
  timeStringToMinutes,
  minuteUtcToDate,
  dateToMinuteUtc,
  isNextDayOfWeek,
  validateWeeklySlotTimeOrder,
  slotsOverlap,
  isMinuteWithinWeeklySlot,
  getTimezoneOffsetMinutes,
  DAY_OF_WEEK_TO_INDEX,
} from "@/utils/slotAllocation/slotTimeUtils";
import { DayOfWeek } from "@prisma/client";

// ─── minutesToTimeString / timeStringToMinutes ──────────────────────────────

describe("minutesToTimeString", () => {
  it("should format midnight as 00:00", () => {
    expect(minutesToTimeString(0)).toBe("00:00");
  });

  it("should format 9:30 AM", () => {
    expect(minutesToTimeString(570)).toBe("09:30");
  });

  it("should format 23:59", () => {
    expect(minutesToTimeString(1439)).toBe("23:59");
  });
});

describe("timeStringToMinutes", () => {
  it("should parse 00:00 as 0", () => {
    expect(timeStringToMinutes("00:00")).toBe(0);
  });

  it("should parse 09:30 as 570", () => {
    expect(timeStringToMinutes("09:30")).toBe(570);
  });

  it("should round-trip with minutesToTimeString", () => {
    for (const m of [0, 60, 330, 720, 1439]) {
      expect(timeStringToMinutes(minutesToTimeString(m))).toBe(m);
    }
  });
});

// ─── isMinuteWithinWeeklySlot: Timezone day-shift (TEST-1) ──────────────────

describe("isMinuteWithinWeeklySlot - timezone day shift", () => {
  // IST consultant (UTC+5:30 = 330 minutes)
  // Local Monday 01:00-05:00 IST = UTC Sunday 19:30-23:30
  // startTimeUtc = 19*60+30 = 1170, endTimeUtc = 23*60+30 = 1410
  // startDay = MONDAY (local), utcOffsetMinutes = 330

  const IST_OFFSET = 330;

  it("should match UTC Sunday for IST Monday slot", () => {
    // IST Monday 01:00 = UTC Sunday 19:30
    // Candidate: Sunday (day=0) at 19:30 (1170 min), 30-min slot
    const result = isMinuteWithinWeeklySlot(
      0, // candidateDay: Sunday (UTC)
      1170, // candidateMinutes: 19:30 UTC
      30, // slotDurationMinutes
      "MONDAY", // availStartDay (local)
      1170, // availStartTimeUtc: 19:30 UTC
      1410, // availEndTimeUtc: 23:30 UTC
      IST_OFFSET,
    );
    expect(result).toBe(true);
  });

  it("should match UTC Sunday 22:00 within IST Monday 01:00-05:00 window", () => {
    // 22:00 UTC = 03:30 IST, within 01:00-05:00 IST
    const result = isMinuteWithinWeeklySlot(
      0, // Sunday
      1320, // 22:00 UTC
      30,
      "MONDAY",
      1170, // 19:30 UTC
      1410, // 23:30 UTC
      IST_OFFSET,
    );
    expect(result).toBe(true);
  });

  it("should NOT match UTC Monday for IST Monday slot", () => {
    // Without timezone adjustment, the system would wrongly look for Monday in UTC.
    // IST Monday 01:00 = UTC Sunday 19:30, so UTC Monday 19:30 is actually IST Tuesday.
    const result = isMinuteWithinWeeklySlot(
      1, // candidateDay: Monday (UTC)
      1170, // candidateMinutes: 19:30 UTC
      30,
      "MONDAY",
      1170,
      1410,
      IST_OFFSET,
    );
    expect(result).toBe(false);
  });

  it("should NOT match candidate outside the time window", () => {
    // Sunday 18:00 UTC = Monday 23:30 IST — before the 01:00 IST window
    // But in UTC terms, 18:00 < 19:30 startTimeUtc, so it's outside
    const result = isMinuteWithinWeeklySlot(
      0, // Sunday
      1080, // 18:00 UTC
      30,
      "MONDAY",
      1170,
      1410,
      IST_OFFSET,
    );
    expect(result).toBe(false);
  });

  // UTC+0 consultant (no shift) — regression: day should match directly
  it("should match same day for UTC+0 consultant", () => {
    // Monday 10:00-17:00 UTC, offset = 0
    const result = isMinuteWithinWeeklySlot(
      1, // Monday
      600, // 10:00
      30,
      "MONDAY",
      600, // 10:00
      1020, // 17:00
      0, // UTC
    );
    expect(result).toBe(true);
  });

  // EST consultant (UTC-5 = -300 minutes)
  // Local Monday 20:00-22:00 EST = UTC Tuesday 01:00-03:00
  // startTimeUtc = 60, endTimeUtc = 180
  // startDay = MONDAY (local), utcOffsetMinutes = -300
  it("should match UTC Tuesday for EST Monday evening slot", () => {
    // EST Monday 20:00 = UTC Tuesday 01:00
    const result = isMinuteWithinWeeklySlot(
      2, // Tuesday (UTC)
      60, // 01:00 UTC
      30,
      "MONDAY",
      60, // startTimeUtc: 01:00 UTC
      180, // endTimeUtc: 03:00 UTC
      -300,
    );
    expect(result).toBe(true);
  });

  it("should NOT match UTC Monday for EST Monday evening slot", () => {
    const result = isMinuteWithinWeeklySlot(
      1, // Monday (UTC)
      60, // 01:00 UTC
      30,
      "MONDAY",
      60,
      180,
      -300,
    );
    expect(result).toBe(false);
  });
});

// ─── isMinuteWithinWeeklySlot: Overnight slots (TEST-3) ─────────────────────

describe("isMinuteWithinWeeklySlot - overnight slots", () => {
  // Consultant with Mon 22:00 -> Tue 02:00 UTC availability
  // This is overnight: startTimeUtc = 1320, endTimeUtc = 120
  // startDay = MONDAY, utcOffsetMinutes = 0

  it("should match Monday 22:00 within overnight slot", () => {
    const result = isMinuteWithinWeeklySlot(
      1, // Monday
      1320, // 22:00
      30,
      "MONDAY",
      1320, // 22:00
      120, // 02:00 (next day)
      0,
    );
    expect(result).toBe(true);
  });

  it("should match Monday 23:30 within overnight slot", () => {
    const result = isMinuteWithinWeeklySlot(
      1, // Monday
      1410, // 23:30
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(true);
  });

  it("should match Tuesday 00:00 within overnight slot (carry-over)", () => {
    const result = isMinuteWithinWeeklySlot(
      2, // Tuesday
      0, // 00:00
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(true);
  });

  it("should match Tuesday 01:00 within overnight slot", () => {
    const result = isMinuteWithinWeeklySlot(
      2, // Tuesday
      60, // 01:00
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(true);
  });

  it("should NOT match Tuesday 02:00 (at boundary, slot ends at 02:00)", () => {
    // candidateEndMinutes = 02:00 + 30min = 02:30 > endTimeUtc (120)
    const result = isMinuteWithinWeeklySlot(
      2, // Tuesday
      120, // 02:00
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(false);
  });

  it("should NOT match Monday 21:00 (before overnight start)", () => {
    const result = isMinuteWithinWeeklySlot(
      1, // Monday
      1260, // 21:00
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(false);
  });

  it("should NOT match Wednesday within a Mon-Tue overnight slot", () => {
    const result = isMinuteWithinWeeklySlot(
      3, // Wednesday
      60, // 01:00
      30,
      "MONDAY",
      1320,
      120,
      0,
    );
    expect(result).toBe(false);
  });
});

// ─── isMinuteWithinWeeklySlot: Overnight + timezone combined ────────────────

describe("isMinuteWithinWeeklySlot - overnight + timezone", () => {
  // IST consultant (UTC+5:30) with local Friday 22:00 -> Saturday 02:00 IST
  // = UTC Friday 16:30 -> Friday 20:30 (same day in UTC — NOT overnight in UTC)
  // startTimeUtc = 990 (16:30), endTimeUtc = 1230 (20:30)
  // utcOffsetMinutes = 330, startDay = FRIDAY (local)

  it("should match UTC Friday for IST Friday evening slot (same-day in UTC)", () => {
    const result = isMinuteWithinWeeklySlot(
      5, // Friday (UTC)
      990, // 16:30 UTC
      30,
      "FRIDAY",
      990,
      1230,
      330,
    );
    expect(result).toBe(true);
  });

  // IST consultant with local Saturday 23:00 -> Sunday 03:00 IST
  // = UTC Saturday 17:30 -> Sunday 21:30 (overnight in UTC too)
  // startTimeUtc = 1050 (17:30), endTimeUtc = 1290 (21:30)
  // Wait, that doesn't cross midnight in UTC either.
  // Let's do: IST local Monday 02:00 -> 06:00 IST = UTC Sunday 20:30 -> Monday 00:30
  // startTimeUtc = 1230 (20:30), endTimeUtc = 30 (00:30) — overnight in UTC
  // startDay = MONDAY (local), utcOffsetMinutes = 330

  it("should handle IST early-morning slot that is overnight in UTC", () => {
    // IST Monday 02:00-06:00 = UTC Sunday 20:30 to Monday 00:30
    // Candidate: UTC Sunday 21:00 (1260 min), day=0
    const result = isMinuteWithinWeeklySlot(
      0, // Sunday (UTC)
      1260, // 21:00 UTC
      30,
      "MONDAY",
      1230, // 20:30 UTC
      30, // 00:30 UTC (next day — overnight)
      330,
    );
    expect(result).toBe(true);
  });

  it("should match UTC Monday 00:00 in IST Monday early-morning overnight slot", () => {
    const result = isMinuteWithinWeeklySlot(
      1, // Monday (UTC)
      0, // 00:00 UTC
      30,
      "MONDAY",
      1230,
      30,
      330,
    );
    expect(result).toBe(true);
  });
});

// ─── validateWeeklySlotTimeOrder ────────────────────────────────────────────

describe("validateWeeklySlotTimeOrder", () => {
  it("should accept valid same-day slot", () => {
    expect(
      validateWeeklySlotTimeOrder(
        DayOfWeek.MONDAY,
        DayOfWeek.MONDAY,
        540,
        1020,
      ),
    ).toBeNull();
  });

  it("should reject same-day slot where start >= end", () => {
    expect(
      validateWeeklySlotTimeOrder(
        DayOfWeek.MONDAY,
        DayOfWeek.MONDAY,
        1020,
        540,
      ),
    ).toContain("before end time");
  });

  it("should accept valid overnight slot (Mon 22:00 -> Tue 02:00)", () => {
    expect(
      validateWeeklySlotTimeOrder(
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        1320,
        120,
      ),
    ).toBeNull();
  });

  it("should reject overnight slot spanning >1 day", () => {
    expect(
      validateWeeklySlotTimeOrder(
        DayOfWeek.MONDAY,
        DayOfWeek.WEDNESDAY,
        1320,
        120,
      ),
    ).toContain("day after startDay");
  });

  it("should reject overnight slot that doesn't actually cross midnight", () => {
    // Mon 02:00 -> Tue 22:00 would be >24h
    expect(
      validateWeeklySlotTimeOrder(
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        120,
        1320,
      ),
    ).toContain("cross midnight");
  });
});

// ─── slotsOverlap ───────────────────────────────────────────────────────────

describe("slotsOverlap", () => {
  it("should detect overlap between same-day slots", () => {
    expect(
      slotsOverlap(
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.MONDAY,
          startTimeUtc: 540,
          endTimeUtc: 720,
        },
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.MONDAY,
          startTimeUtc: 600,
          endTimeUtc: 780,
        },
      ),
    ).toBe(true);
  });

  it("should not detect overlap for non-overlapping same-day slots", () => {
    expect(
      slotsOverlap(
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.MONDAY,
          startTimeUtc: 540,
          endTimeUtc: 600,
        },
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.MONDAY,
          startTimeUtc: 600,
          endTimeUtc: 720,
        },
      ),
    ).toBe(false);
  });

  it("should detect overlap between overnight slot and same-day slot on carry-over day", () => {
    // Mon 22:00->Tue 02:00 overlaps with Tue 01:00->02:00
    expect(
      slotsOverlap(
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.TUESDAY,
          startTimeUtc: 1320,
          endTimeUtc: 120,
        },
        {
          startDay: DayOfWeek.TUESDAY,
          endDay: DayOfWeek.TUESDAY,
          startTimeUtc: 60,
          endTimeUtc: 120,
        },
      ),
    ).toBe(true);
  });

  it("should not overlap slots on different days", () => {
    expect(
      slotsOverlap(
        {
          startDay: DayOfWeek.MONDAY,
          endDay: DayOfWeek.MONDAY,
          startTimeUtc: 540,
          endTimeUtc: 720,
        },
        {
          startDay: DayOfWeek.TUESDAY,
          endDay: DayOfWeek.TUESDAY,
          startTimeUtc: 540,
          endTimeUtc: 720,
        },
      ),
    ).toBe(false);
  });
});

// ─── getTimezoneOffsetMinutes: range validation (MED-2) ─────────────────────

describe("getTimezoneOffsetMinutes", () => {
  it("should return 0 for invalid timezone", () => {
    expect(getTimezoneOffsetMinutes("Invalid/Timezone")).toBe(0);
  });

  it("should return 0 for UTC", () => {
    expect(getTimezoneOffsetMinutes("UTC")).toBe(0);
  });

  it("should return a valid offset for known timezone", () => {
    const offset = getTimezoneOffsetMinutes("Asia/Kolkata");
    // IST is always UTC+5:30 = 330 minutes (no DST)
    expect(offset).toBe(330);
  });

  it("should return offset within valid range", () => {
    const offset = getTimezoneOffsetMinutes("America/New_York");
    expect(offset).toBeGreaterThanOrEqual(-840);
    expect(offset).toBeLessThanOrEqual(840);
  });
});
