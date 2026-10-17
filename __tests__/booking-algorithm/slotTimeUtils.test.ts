/**
 * Tests for slotTimeUtils
 *
 * Covers:
 * - minutesToTimeString / timeStringToMinutes: round-trip
 * - validateWeeklySlotTimeOrder: same-day and overnight validation
 * - slotsOverlap: same-day and overnight overlap detection
 * - getTimezoneOffsetMinutes: range validation (MED-2)
 */

import "./setup";

import {
  minutesToTimeString,
  timeStringToMinutes,
  validateWeeklySlotTimeOrder,
  slotsOverlap,
  getTimezoneOffsetMinutes,
} from "@/utils/scheduling-engine/slotTimeUtils";
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
  const local = (
    localStartDay: DayOfWeek,
    localStartMinutes: number,
    localEndMinutes: number,
    localEndDay: DayOfWeek = localStartDay,
  ) => ({ localStartDay, localStartMinutes, localEndMinutes, localEndDay });

  it("should detect overlap between same-day slots", () => {
    expect(
      slotsOverlap(
        local(DayOfWeek.MONDAY, 540, 720),
        local(DayOfWeek.MONDAY, 600, 780),
      ),
    ).toBe(true);
  });

  it("should not detect overlap for back-to-back same-day slots", () => {
    expect(
      slotsOverlap(
        local(DayOfWeek.MONDAY, 540, 600),
        local(DayOfWeek.MONDAY, 600, 720),
      ),
    ).toBe(false);
  });

  it("should detect overlap between an overnight slot and its carry-over day", () => {
    // Mon 22:00 -> Tue 02:00 overlaps Tue 01:00 -> 02:00
    expect(
      slotsOverlap(
        local(DayOfWeek.MONDAY, 1320, 120, DayOfWeek.TUESDAY),
        local(DayOfWeek.TUESDAY, 60, 120),
      ),
    ).toBe(true);
  });

  it("should not overlap slots on different days", () => {
    expect(
      slotsOverlap(
        local(DayOfWeek.MONDAY, 540, 720),
        local(DayOfWeek.TUESDAY, 540, 720),
      ),
    ).toBe(false);
  });

  it("should wrap a Saturday overnight slot onto Sunday morning", () => {
    expect(
      slotsOverlap(
        local(DayOfWeek.SATURDAY, 1380, 60, DayOfWeek.SUNDAY),
        local(DayOfWeek.SUNDAY, 0, 30),
      ),
    ).toBe(true);
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
