/**
 * #1703 QA-1 — the grid is drawn in ONE zone, the viewer's profile zone, and
 * the footer label is derived from that zone rather than from `Intl`.
 */
import {
  cellInstant,
  dayRangeBounds,
  footerZoneLine,
  isOnCalendarDay,
  resolveGridZone,
  rowOf,
} from "@/lib/time/grid-zone";

/** 2026-09-24 as a calendar date; 08:30Z is 14:00 in Kolkata and 05:30 in Bahia. */
const day = new Date(2026, 8, 24, 12);
const at = new Date("2026-09-24T08:30:00Z");

describe("grid zone", () => {
  it("prefers a valid profile zone and falls back to the browser's", () => {
    expect(resolveGridZone("America/Bahia", "Asia/Kolkata")).toBe(
      "America/Bahia",
    );
    expect(resolveGridZone(null, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(resolveGridZone("Not/AZone", "Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("turns a cell's wall clock into the instant of the grid zone", () => {
    expect(cellInstant(day, 14, 0, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-24T08:30:00.000Z",
    );
    expect(cellInstant(day, 5, 30, "America/Bahia").toISOString()).toBe(
      "2026-09-24T08:30:00.000Z",
    );
    expect(rowOf(at, "America/Bahia")).toEqual({ rowIndex: 11, fraction: 0 });
    expect(isOnCalendarDay(day, at, "America/Bahia")).toBe(true);
  });

  it("bounds the fetch window on the grid zone's midnights", () => {
    const { start, end } = dayRangeBounds(day, day, "America/Bahia");
    expect(start.toISOString()).toBe("2026-09-24T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-25T02:59:59.999Z");
  });

  it("labels the footer from the zone it is handed, not Intl", () => {
    const line = footerZoneLine(at, "America/Bahia", "Asia/Kolkata");
    // The abbreviation is ICU's ("GMT-3" today); only the offset is pinned.
    expect(line.label).toMatch(/^Times in \S+ \(UTC-03:00\)$/);
    expect(line.title).toBe("America/Bahia");
    expect(line.limits).toEqual({
      label: "Limits counted in IST (UTC+05:30)",
      title: "Asia/Kolkata",
    });
    expect(
      footerZoneLine(at, "Asia/Calcutta", "Asia/Kolkata").limits,
    ).toBeNull();
  });
});
