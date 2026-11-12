/**
 * The class pattern projection: N starts on the host's wall clock, DST-safe,
 * skipping times the lattice or the lead can't hold.
 */

import { formatInTimeZone } from "date-fns-tz";

import {
  patternProblem,
  projectPattern,
  seriesStartsFrom,
  sessionAtoms,
} from "@/lib/booking/class-pattern";

describe("projectPattern", () => {
  it("places Mon and Thu at 18:00 for six sessions, in order", () => {
    const starts = projectPattern(
      {
        startDate: "2026-12-01", // a Tuesday
        rows: [
          { weekday: 4, startMinutes: 18 * 60 },
          { weekday: 1, startMinutes: 18 * 60 },
        ],
        zone: "Asia/Kolkata",
      },
      6,
    );
    expect(
      starts.map((s) =>
        formatInTimeZone(s, "Asia/Kolkata", "EEE dd MMM HH:mm"),
      ),
    ).toEqual([
      "Thu 03 Dec 18:00",
      "Mon 07 Dec 18:00",
      "Thu 10 Dec 18:00",
      "Mon 14 Dec 18:00",
      "Thu 17 Dec 18:00",
      "Mon 21 Dec 18:00",
    ]);
  });

  it("keeps 18:00 local across a daylight-saving change", () => {
    // New York leaves DST on Sun 1 Nov 2026.
    const starts = projectPattern(
      {
        startDate: "2026-10-26",
        rows: [{ weekday: 1, startMinutes: 18 * 60 }],
        zone: "America/New_York",
      },
      2,
    );
    expect(starts.map((s) => s.toISOString())).toEqual([
      "2026-10-26T22:00:00.000Z",
      "2026-11-02T23:00:00.000Z",
    ]);
  });

  it("skips a start before the lead instead of losing a session", () => {
    const starts = projectPattern(
      {
        startDate: "2026-12-07",
        rows: [{ weekday: 1, startMinutes: 9 * 60 }],
        zone: "UTC",
      },
      2,
      Date.parse("2026-12-07T10:00:00.000Z"),
    );
    expect(starts.map((s) => s.toISOString())).toEqual([
      "2026-12-14T09:00:00.000Z",
      "2026-12-21T09:00:00.000Z",
    ]);
  });

  it("offers 18:15 in a :45 zone and refuses 18:00 as off the grid", () => {
    // 18:15 in Kathmandu is 12:30 UTC; 18:00 is 12:15 UTC.
    const zone = "Asia/Kathmandu";
    const at = (startMinutes: number) => ({
      startDate: "2026-12-07",
      rows: [{ weekday: 1, startMinutes }],
      zone,
    });
    expect(patternProblem(at(18 * 60 + 15), 2)).toBeNull();
    expect(
      projectPattern(at(18 * 60 + 15), 2).map((s) => s.toISOString()),
    ).toEqual(["2026-12-07T12:30:00.000Z", "2026-12-14T12:30:00.000Z"]);
    expect(patternProblem(at(18 * 60), 2)).toBe("OFF_GRID_TIME");
  });
});

describe("patternProblem", () => {
  const base = { startDate: "2026-12-01", zone: "UTC" };
  it("accepts two times on one day for a class, refuses three", () => {
    const two = [
      { weekday: 1, startMinutes: 540 },
      { weekday: 1, startMinutes: 600 },
    ];
    expect(patternProblem({ ...base, rows: two }, 2)).toBeNull();
    expect(
      patternProblem(
        { ...base, rows: [...two, { weekday: 1, startMinutes: 660 }] },
        2,
      ),
    ).toBe("TOO_MANY_PER_DAY");
  });
  it("refuses empty, duplicate and off-grid rows", () => {
    expect(patternProblem({ ...base, rows: [] }, 2)).toBe("NO_ROWS");
    expect(
      patternProblem({ ...base, rows: [{ weekday: 1, startMinutes: 545 }] }, 2),
    ).toBe("OFF_GRID_TIME");
    expect(
      patternProblem(
        {
          ...base,
          rows: [
            { weekday: 1, startMinutes: 540 },
            { weekday: 1, startMinutes: 540 },
          ],
        },
        2,
      ),
    ).toBe("DUPLICATE_ROW");
  });
});

describe("sessionAtoms", () => {
  it("expands each 90-minute session into three half-hour atoms", () => {
    expect(sessionAtoms([new Date("2026-12-07T09:00:00.000Z")], 90)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:30:00.000Z",
      "2026-12-07T10:00:00.000Z",
    ]);
  });
});

describe("seriesStartsFrom", () => {
  it("spreads two a week from the first session and keeps its local time across DST", () => {
    // Mon 26 Oct 2026 18:00 in New York; clocks go back on Sun 1 Nov.
    const starts = seriesStartsFrom(
      new Date("2026-10-26T22:00:00.000Z"),
      2,
      4,
      "America/New_York",
    );
    expect(
      starts.map((s) =>
        formatInTimeZone(s, "America/New_York", "EEE dd MMM HH:mm"),
      ),
    ).toEqual([
      "Mon 26 Oct 18:00",
      "Thu 29 Oct 18:00",
      "Mon 02 Nov 18:00",
      "Thu 05 Nov 18:00",
    ]);
  });
});
