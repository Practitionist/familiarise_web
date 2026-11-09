/**
 * Feasibility: can a plan's weekly cadence be delivered from published hours?
 *
 * Worked example used throughout: an expert in Asia/Kolkata publishes Mon, Wed
 * and Fri 18:00–20:00. A 60-minute, 3-a-week subscription (one a day) fits
 * exactly; a 4-a-week plan can never fit; a 150-minute session fits nowhere.
 */

import {
  assessFeasibility,
  buyerFeasibilityNotice,
  mergeSpans,
  subtractSpans,
  zoneDayBoundaries,
  type TimeSpan,
} from "@/lib/booking/feasibility";

const ZONE = "Asia/Kolkata";
const HOUR = 3_600_000;
// Monday 2026-11-16 00:00 IST.
const MONDAY = Date.parse("2026-11-15T18:30:00Z");

/** 18:00–20:00 IST on the given day offsets from MONDAY, for `weeks` weeks. */
function eveningWindows(dayOffsets: number[], weeks: number): TimeSpan[] {
  const spans: TimeSpan[] = [];
  for (let week = 0; week < weeks; week += 1) {
    for (const offset of dayOffsets) {
      const day = MONDAY + (week * 7 + offset) * 24 * HOUR;
      spans.push({ startMs: day + 18 * HOUR, endMs: day + 20 * HOUR });
    }
  }
  return spans;
}

const base = {
  zone: ZONE,
  sessionMinutes: 60,
  sessionsPerWeek: 3,
  perDayCap: 1,
  notBeforeMs: MONDAY,
  weeks: 4,
  busy: [] as TimeSpan[],
};

describe("span arithmetic", () => {
  it("merges touching and overlapping spans", () => {
    expect(
      mergeSpans([
        { startMs: 5, endMs: 8 },
        { startMs: 0, endMs: 5 },
        { startMs: 7, endMs: 10 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 10 }]);
  });

  it("subtracts held time from free time", () => {
    expect(
      subtractSpans(
        [{ startMs: 0, endMs: 10 }],
        [
          { startMs: 2, endMs: 3 },
          { startMs: 8, endMs: 12 },
        ],
      ),
    ).toEqual([
      { startMs: 0, endMs: 2 },
      { startMs: 3, endMs: 8 },
    ]);
  });

  it("cuts days on the zone's midnights", () => {
    const days = zoneDayBoundaries(MONDAY + 5 * HOUR, ZONE, 2);
    expect(days).toEqual([MONDAY, MONDAY + 24 * HOUR, MONDAY + 48 * HOUR]);
  });
});

describe("assessFeasibility", () => {
  it("passes a cadence the published hours hold exactly, but flags no headroom", () => {
    const report = assessFeasibility({
      ...base,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(report.weeks.map((w) => w.placeable)).toEqual([3, 3, 3, 3]);
    // 3 of 3 is deliverable but brittle: one busy evening leaves a week short.
    expect(report.verdict).toBe("tight");
    expect(report.reasons.map((r) => r.code)).toEqual(["LOW_HEADROOM"]);
  });

  it("is ok with headroom", () => {
    const report = assessFeasibility({
      ...base,
      windows: eveningWindows([0, 1, 2, 3, 4], 4),
    });
    expect(report.verdict).toBe("ok");
    expect(report.reasons).toEqual([]);
  });

  it("refuses more sessions a week than open days times the daily cap", () => {
    const report = assessFeasibility({
      ...base,
      sessionsPerWeek: 4,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(report.verdict).toBe("impossible");
    expect(report.reasons[0].code).toBe("TOO_FEW_OPEN_HOURS");
    expect(report.bestWeekPublishedSessions).toBe(3);
  });

  it("refuses a session longer than every published window", () => {
    const report = assessFeasibility({
      ...base,
      sessionMinutes: 150,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(report.verdict).toBe("impossible");
    expect(report.reasons[0].code).toBe("SESSION_LONGER_THAN_WINDOWS");
    expect(report.longestWindowMinutes).toBe(120);
  });

  it("refuses an expert with no published hours", () => {
    const report = assessFeasibility({ ...base, windows: [] });
    expect(report.verdict).toBe("impossible");
    expect(report.reasons[0].code).toBe("NO_AVAILABILITY");
  });

  it("counts existing bookings and reports the short weeks", () => {
    // Week 1's Monday and Wednesday evenings are fully booked.
    const busy = [0, 2].map((offset) => {
      const day = MONDAY + offset * 24 * HOUR;
      return { startMs: day + 18 * HOUR, endMs: day + 20 * HOUR };
    });
    const report = assessFeasibility({
      ...base,
      busy,
      windows: eveningWindows([0, 1, 2, 3, 4], 4),
    });
    expect(report.weeks[0]).toMatchObject({
      publishedCapacity: 3,
      placeable: 3,
    });
    const tighter = assessFeasibility({
      ...base,
      busy,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(tighter.weeks[0].placeable).toBe(1);
    expect(tighter.reasons.map((r) => r.code)).toContain("WEEKS_SHORT");
    expect(buyerFeasibilityNotice(tighter, 3)).toBe(
      "This expert currently has room for about 1 of 3 sessions a week. Sessions that can't be scheduled before the plan ends are refunded.",
    );
  });

  it("skips time before the lead-time floor", () => {
    // It is Monday 19:30 IST: Monday's 18:00 and 19:00 starts have passed.
    const report = assessFeasibility({
      ...base,
      notBeforeMs: MONDAY + 19.5 * HOUR,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(report.weeks[0].placeable).toBe(2);
  });

  it("lets a class place two sessions a day", () => {
    const report = assessFeasibility({
      ...base,
      perDayCap: 2,
      sessionsPerWeek: 6,
      windows: eveningWindows([0, 2, 4], 4),
    });
    expect(report.weeks[0].placeable).toBe(6);
  });

  it("aligns odd window edges to the half-hour lattice", () => {
    // 18:10–19:40 holds one 60-minute session (18:30–19:30), not one and a half.
    const day = MONDAY;
    const report = assessFeasibility({
      ...base,
      sessionsPerWeek: 1,
      weeks: 1,
      windows: [
        {
          startMs: day + 18 * HOUR + 10 * 60_000,
          endMs: day + 19 * HOUR + 40 * 60_000,
        },
      ],
    });
    expect(report.weeks[0].placeable).toBe(1);
    expect(report.longestWindowMinutes).toBe(60);
  });
});
