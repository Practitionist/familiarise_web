/**
 * Per-day grid rows in the display zone: DST days have 46/50 rows (47/49 for
 * a half-hour shift), the repeated hour is labelled, rows stay on the UTC
 * :00/:30 atom grid for :45 offsets, and a cell's instant never depends on
 * the device's own zone.
 */
import {
  calendarDateKey,
  cellInstant,
  dayRangeBounds,
  dayRows,
  resolveGridZone,
  weekRowModel,
} from "@/lib/time/grid-zone";

const day = (year: number, month: number, date: number) =>
  new Date(year, month - 1, date, 12);

describe("dayRows — one row per 30-minute atom of the calendar day", () => {
  it("Asia/Kolkata: 48 rows on :00/:30, no clock changes", () => {
    const rows = dayRows(day(2026, 3, 8), "Asia/Kolkata");
    expect(rows).toHaveLength(48);
    expect(rows[0].start.toISOString()).toBe("2026-03-07T18:30:00.000Z");
    expect(rows.every((row) => row.occurrence === 0)).toBe(true);
    expect(new Set(rows.map((row) => row.key)).size).toBe(48);
  });

  it("America/New_York spring-forward: 46 rows, 2:00 and 2:30 skipped", () => {
    const rows = dayRows(day(2026, 3, 8), "America/New_York");
    expect(rows).toHaveLength(46);
    const minutes = rows.map((row) => row.minuteOfDay);
    expect(minutes).not.toContain(120);
    expect(minutes).not.toContain(150);
    expect(minutes).toContain(180);
    // Every row is a distinct instant: no duplicated cell.
    expect(new Set(rows.map((row) => row.start.getTime())).size).toBe(46);
  });

  it("America/New_York fall-back: 50 rows, the repeated hour is labelled (2nd)", () => {
    const rows = dayRows(day(2026, 11, 1), "America/New_York");
    expect(rows).toHaveLength(50);
    const repeats = rows.filter((row) => row.occurrence === 1);
    expect(repeats.map((row) => row.minuteOfDay)).toEqual([60, 90]);
    expect(repeats[0].label).toMatch(/\(2nd\)$/);
    expect(repeats[0].key).toBe("60#2");
    // The second 1:00 is an hour after the first.
    const first = rows.find((row) => row.key === "60");
    expect(repeats[0].start.getTime() - (first?.start.getTime() ?? 0)).toBe(
      60 * 60 * 1000,
    );
  });

  it("Asia/Kathmandu (+05:45): rows on UTC :00/:30, labelled at :15/:45", () => {
    const rows = dayRows(day(2026, 3, 8), "Asia/Kathmandu");
    expect(rows).toHaveLength(48);
    expect(rows.every((row) => row.start.getUTCMinutes() % 30 === 0)).toBe(
      true,
    );
    expect(rows.every((row) => [15, 45].includes(row.minuteOfDay % 60))).toBe(
      true,
    );
    // 09:15 local is 03:30Z.
    const nineFifteen = rows.find((row) => row.minuteOfDay === 9 * 60 + 15);
    expect(nineFifteen?.start.toISOString()).toBe("2026-03-08T03:30:00.000Z");
  });

  it("Australia/Lord_Howe half-hour shift: 49 rows on fall-back, 47 on spring-forward", () => {
    // Lord Howe moves 30 minutes: back at 02:00 on 5 Apr 2026, forward at 02:00 on 4 Oct 2026.
    const back = dayRows(day(2026, 4, 5), "Australia/Lord_Howe");
    expect(back).toHaveLength(49);
    expect(back.filter((row) => row.occurrence === 1)).toHaveLength(1);
    const forward = dayRows(day(2026, 10, 4), "Australia/Lord_Howe");
    expect(forward).toHaveLength(47);
    expect(forward.map((row) => row.minuteOfDay)).not.toContain(120);
  });
});

describe("dayRows — zones whose clocks change at midnight", () => {
  it.each([
    ["America/Santiago", day(2026, 9, 5), day(2026, 9, 6)],
    ["America/Havana", day(2026, 3, 7), day(2026, 3, 8)],
  ])(
    "%s: the day before keeps 48 rows, the spring day has 46 starting at 1:00",
    (zone, before, spring) => {
      expect(dayRows(before, zone)).toHaveLength(48);
      const rows = dayRows(spring, zone);
      expect(rows).toHaveLength(46);
      expect(rows[0].minuteOfDay).toBe(60);
      expect(rows.some((row) => row.occurrence === 1)).toBe(false);
      const week = weekRowModel([before, spring], zone);
      expect(week.axis).toHaveLength(48);
      expect(week.axis.some((row) => row.occurrence === 1)).toBe(false);
    },
  );
});

describe("weekRowModel — the union of the week's rows", () => {
  it("keeps the fall-back repeat as its own row, in time order; other days have no cell there", () => {
    const days = [day(2026, 10, 31), day(2026, 11, 1), day(2026, 11, 2)];
    const model = weekRowModel(days, "America/New_York");
    const keys = model.axis.map((row) => row.key);
    const at = keys.indexOf("60");
    expect(keys.slice(at, at + 5)).toEqual(["60", "90", "60#2", "90#2", "120"]);
    expect(model.cells[1].has("60#2")).toBe(true);
    expect(model.cells[0].has("60#2")).toBe(false);
    expect(model.cells[2].has("60#2")).toBe(false);
  });

  it("keeps the skipped spring-forward times as rows other days still have", () => {
    const days = [day(2026, 3, 8), day(2026, 3, 9)];
    const model = weekRowModel(days, "America/New_York");
    const keys = model.axis.map((row) => row.key);
    expect(keys.indexOf("120")).toBe(keys.indexOf("90") + 1);
    expect(model.cells[0].has("120")).toBe(false);
    expect(model.cells[1].has("120")).toBe(true);
  });
});

describe("cell instants never read the device zone", () => {
  it("builds the instant from the calendar date fields and the grid zone alone", () => {
    // 8 Mar 2026 is spring-forward in New York; an IST grid must not care.
    expect(
      cellInstant(day(2026, 3, 8), 2, 0, "Asia/Kolkata").toISOString(),
    ).toBe("2026-03-07T20:30:00.000Z");
    expect(calendarDateKey(day(2026, 3, 8))).toBe("2026-03-08");
  });

  it("bounds a DST day by its own midnights (23 hours long)", () => {
    const { start, end } = dayRangeBounds(
      day(2026, 3, 8),
      day(2026, 3, 8),
      "America/New_York",
    );
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe("display zone", () => {
  it("is the profile zone first, the device zone when switched or missing", () => {
    expect(resolveGridZone("Asia/Kolkata", "Europe/London")).toBe(
      "Asia/Kolkata",
    );
    expect(resolveGridZone("Asia/Kolkata", "Europe/London", true)).toBe(
      "Europe/London",
    );
    expect(resolveGridZone(null, "Europe/London")).toBe("Europe/London");
    expect(resolveGridZone("Not/AZone", "Europe/London")).toBe("Europe/London");
  });
});
