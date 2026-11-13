/**
 * @jest-environment node
 */

/**
 * Weekly rows follow the expert's local clock across DST: each occurrence is
 * materialised from the row's local columns in its own IANA zone.
 */

import fs from "fs";
import path from "path";
import fc from "fast-check";
import { formatInTimeZone } from "date-fns-tz";
import type { DayOfWeek } from "@prisma/client";

jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));

import { captureThrottled } from "../../lib/observability/throttled-capture";
import {
  DAY_BY_INDEX,
  createWeeklyCoverage,
  isInstantWithinWeeklyRow,
  sameTimeZone,
  weeklyRowIntervalsInRange,
  zoneOffsetMinutesAt,
  type WeeklyRowLocalColumns,
} from "../../utils/schedule/weekly-projection";
import { loadPublishedCoverage } from "../../utils/scheduling-engine/availabilityCoverage";
import { weeklyZoneRefusal } from "../../lib/scheduling/availability-contract";
import { resolveWeeklyTimezone } from "../../lib/scheduling/weeklyUtcOffset";
import { processAvailabilitySlots } from "../../utils/scheduling-engine/intervals";
import { dayRangeBounds } from "../../lib/time/grid-zone";
import type { Tx } from "../../lib/prisma";

const row = (
  timezone: string,
  localStartDay: DayOfWeek,
  localStartMinutes: number,
  localEndMinutes: number,
  localEndDay: DayOfWeek = localStartDay,
): WeeklyRowLocalColumns => ({
  timezone,
  localStartDay,
  localStartMinutes,
  localEndMinutes,
  localEndDay,
});

const isoPairs = (rowValue: WeeklyRowLocalColumns, from: string, to: string) =>
  weeklyRowIntervalsInRange(rowValue, new Date(from), new Date(to)).map((i) => [
    i.start.toISOString(),
    i.end.toISOString(),
  ]);

describe("a Monday 09:00–12:00 row keeps its local clock across each transition", () => {
  it.each([
    [
      "America/New_York",
      "2026-03-02",
      "2026-03-09",
      ["2026-03-02T14:00:00.000Z", "2026-03-02T17:00:00.000Z"],
      ["2026-03-09T13:00:00.000Z", "2026-03-09T16:00:00.000Z"],
    ],
    [
      "America/New_York",
      "2026-10-26",
      "2026-11-02",
      ["2026-10-26T13:00:00.000Z", "2026-10-26T16:00:00.000Z"],
      ["2026-11-02T14:00:00.000Z", "2026-11-02T17:00:00.000Z"],
    ],
    [
      "Europe/London",
      "2026-03-23",
      "2026-03-30",
      ["2026-03-23T09:00:00.000Z", "2026-03-23T12:00:00.000Z"],
      ["2026-03-30T08:00:00.000Z", "2026-03-30T11:00:00.000Z"],
    ],
    [
      "Europe/London",
      "2026-10-19",
      "2026-10-26",
      ["2026-10-19T08:00:00.000Z", "2026-10-19T11:00:00.000Z"],
      ["2026-10-26T09:00:00.000Z", "2026-10-26T12:00:00.000Z"],
    ],
    [
      "Australia/Sydney",
      "2026-03-30",
      "2026-04-06",
      ["2026-03-29T22:00:00.000Z", "2026-03-30T01:00:00.000Z"],
      ["2026-04-05T23:00:00.000Z", "2026-04-06T02:00:00.000Z"],
    ],
    [
      "Australia/Sydney",
      "2026-09-28",
      "2026-10-05",
      ["2026-09-27T23:00:00.000Z", "2026-09-28T02:00:00.000Z"],
      ["2026-10-04T22:00:00.000Z", "2026-10-05T01:00:00.000Z"],
    ],
  ])("%s %s → %s", (zone, before, after, first, second) => {
    const monday = row(zone, "MONDAY", 540, 720);
    const from = new Date(Date.parse(`${before}T00:00:00Z`) - 12 * 3_600_000);
    const to = new Date(Date.parse(`${after}T00:00:00Z`) + 36 * 3_600_000);
    expect(isoPairs(monday, from.toISOString(), to.toISOString())).toEqual([
      first,
      second,
    ]);
  });
});

describe("transition-night wall clocks", () => {
  it("starts a window whose local start does not exist at the jump (spring forward)", () => {
    const sunday = row("America/New_York", "SUNDAY", 150, 210); // 02:30–03:30
    expect(
      isoPairs(sunday, "2026-03-01T00:00:00Z", "2026-03-16T00:00:00Z"),
    ).toEqual([
      ["2026-03-01T07:30:00.000Z", "2026-03-01T08:30:00.000Z"],
      // 02:30 does not exist on 8 Mar: the window runs 03:00–03:30 EDT.
      ["2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z"],
      ["2026-03-15T06:30:00.000Z", "2026-03-15T07:30:00.000Z"],
    ]);
  });

  it("drops only the skipped hour from 02:00–05:00 (spring forward)", () => {
    const sunday = row("America/New_York", "SUNDAY", 120, 300);
    const [interval] = weeklyRowIntervalsInRange(
      sunday,
      new Date("2026-03-08T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z"),
    );
    expect([
      formatInTimeZone(interval.start, "America/New_York", "HH:mm"),
      formatInTimeZone(interval.end, "America/New_York", "HH:mm"),
    ]).toEqual(["03:00", "05:00"]);
    expect(interval.end.getTime() - interval.start.getTime()).toBe(
      2 * 3_600_000,
    );
  });

  it("ends a window whose local end does not exist at the jump", () => {
    const sunday = row("America/New_York", "SUNDAY", 60, 150); // 01:00–02:30
    expect(
      isoPairs(sunday, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z"),
    ).toEqual([["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"]]);
  });

  it("skips a window that lies wholly inside the gap", () => {
    const sunday = row("America/New_York", "SUNDAY", 120, 150); // 02:00–02:30
    expect(
      isoPairs(sunday, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z"),
    ).toEqual([]);
  });

  it("snaps to London's 01:00 jump", () => {
    const sunday = row("Europe/London", "SUNDAY", 30, 180); // 00:30–03:00
    expect(
      isoPairs(sunday, "2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z"),
    ).toEqual([["2026-03-29T00:30:00.000Z", "2026-03-29T02:00:00.000Z"]]);
    const inGap = row("Europe/London", "SUNDAY", 90, 180); // 01:30–03:00
    expect(
      isoPairs(inGap, "2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z"),
    ).toEqual([["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z"]]);
  });

  it("resolves a repeated local time to its first occurrence (fall back)", () => {
    const sunday = row("America/New_York", "SUNDAY", 90, 150); // 01:30–02:30
    expect(
      isoPairs(sunday, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"),
    ).toEqual([["2026-11-01T05:30:00.000Z", "2026-11-01T07:30:00.000Z"]]);
  });
});

describe("overnight rows and window edges", () => {
  const IST = "Asia/Kolkata";

  it("projects 22:00–02:00 as one interval across local midnight", () => {
    const overnight = row(IST, "MONDAY", 1320, 120, "TUESDAY");
    expect(
      isoPairs(overnight, "2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z"),
    ).toEqual([["2026-09-07T16:30:00.000Z", "2026-09-07T20:30:00.000Z"]]);
    // 00:30–01:00 IST Tuesday sits inside it.
    expect(
      isInstantWithinWeeklyRow(
        overnight,
        new Date("2026-09-07T19:00:00Z"),
        new Date("2026-09-07T19:30:00Z"),
      ),
    ).toBe(true);
  });

  it("offers the last 23:30 atom of a zoned week window", () => {
    const window = dayRangeBounds(
      new Date(2026, 8, 7, 12),
      new Date(2026, 8, 13, 12),
      IST,
    );
    expect(window.start.toISOString()).toBe("2026-09-06T18:30:00.000Z");
    expect(window.end.toISOString()).toBe("2026-09-13T18:30:00.000Z");
    const sundayLate = { id: "late", ...row(IST, "SUNDAY", 1380, 0, "MONDAY") };
    const starts = Object.values(
      processAvailabilitySlots(
        [sundayLate],
        [],
        [],
        window.start,
        window.end,
        IST,
      ),
    )
      .flat()
      .map((slot) => slot.startsAt);
    expect(starts).toContain("2026-09-13T18:00:00.000Z");
  });

  it("leaves Asia/Kolkata exactly where the frozen offset put it", () => {
    const monday = row(IST, "MONDAY", 540, 720);
    for (const date of [
      "2026-01-05",
      "2026-07-06",
      "2027-03-29",
      "2028-10-30",
    ]) {
      expect(
        isoPairs(monday, `${date}T00:00:00Z`, `${date}T23:59:00Z`),
      ).toEqual([[`${date}T03:30:00.000Z`, `${date}T06:30:00.000Z`]]);
    }
  });
});

describe("client/server parity", () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  it("projects identically whatever the process zone", () => {
    const rows = [
      row("America/New_York", "SUNDAY", 90, 150),
      row("Australia/Sydney", "MONDAY", 1320, 120, "TUESDAY"),
    ];
    const project = () =>
      rows.flatMap((r) =>
        isoPairs(r, "2026-10-01T00:00:00Z", "2026-11-10T00:00:00Z"),
      );
    process.env.TZ = "UTC";
    const utc = project();
    process.env.TZ = "America/Los_Angeles";
    const browserLike = project();
    process.env.TZ = "Asia/Kolkata";
    expect(project()).toEqual(utc);
    expect(browserLike).toEqual(utc);
  });
});

it("refuses weekly hours in zones off the 30-minute grid", () => {
  expect(weeklyZoneRefusal("Asia/Kathmandu")?.code).toBe("ZONE");
  expect(weeklyZoneRefusal("Africa/Monrovia")?.code).toBe("ZONE"); // −00:44 in 1970
  expect(weeklyZoneRefusal("America/New_York")).toBeNull();
  expect(weeklyZoneRefusal("Asia/Kolkata")).toBeNull();
});

it("keeps a zone whose offset is UTC+0 today", () => {
  expect(resolveWeeklyTimezone("Europe/London")).toBe("Europe/London");
  expect(resolveWeeklyTimezone("Africa/Abidjan")).toBe("Africa/Abidjan");
  expect(resolveWeeklyTimezone("Not/AZone")).toBe("Asia/Kolkata");
  expect(weeklyZoneRefusal("Africa/Monrovia")?.message).toContain("UTC-00:44");
});

it("treats a legacy zone alias as the same zone", () => {
  expect(sameTimeZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
  expect(sameTimeZone("America/New_York", "Europe/London")).toBe(false);
});

describe("rows without local columns", () => {
  it("are refused by the coverage loader and reported once", async () => {
    const complete = { id: "ok", ...row("Asia/Kolkata", "MONDAY", 540, 720) };
    const nulls = {
      id: "legacy",
      timezone: null,
      localStartDay: null,
      localStartMinutes: null,
      localEndMinutes: null,
      localEndDay: null,
    };
    const db = {
      consultantProfile: {
        findUnique: async () => ({ scheduleType: "WEEKLY", deletedAt: null }),
      },
      availabilityWindowWeekly: {
        findMany: async () => [complete, nulls, { ...nulls, id: "legacy-2" }],
      },
      availabilityWindowCustom: { findMany: async () => [] },
    } as unknown as Pick<
      Tx,
      | "consultantProfile"
      | "availabilityWindowWeekly"
      | "availabilityWindowCustom"
    >;
    const coverage = await loadPublishedCoverage(
      db,
      "cp-1",
      new Date("2026-09-07T00:00:00Z"),
      new Date("2026-09-08T00:00:00Z"),
    );
    expect(coverage.weeklyRows.map((r) => r.timezone)).toEqual([
      "Asia/Kolkata",
    ]);
    expect(captureThrottled).toHaveBeenCalledTimes(1);
    expect(jest.mocked(captureThrottled).mock.calls[0][2].extra).toMatchObject({
      refusedCount: 2,
    });
  });
});

describe("property: every occurrence lands on the row's own wall clock", () => {
  const ZONES = [
    "America/New_York",
    "Europe/London",
    "Australia/Sydney",
    "Asia/Kolkata",
    "Asia/Kathmandu",
  ];
  const FROM = Date.UTC(2026, 0, 1);
  const TO = Date.UTC(2028, 11, 24);

  it("holds for any zone, date and row", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.integer({ min: FROM, max: TO }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 47 }),
        fc.integer({ min: 1, max: 24 }),
        (zone, fromMs, dayIndex, startAtom, atoms) => {
          const start = startAtom * 30;
          const end = (start + atoms * 30) % 1440;
          const startDay = DAY_BY_INDEX[dayIndex];
          const endDay =
            end <= start ? DAY_BY_INDEX[(dayIndex + 1) % 7] : startDay;
          const weekly = row(zone, startDay, start, end, endDay);
          const intervals = weeklyRowIntervalsInRange(
            weekly,
            new Date(fromMs),
            new Date(fromMs + 8 * 86_400_000),
          );
          const clock = (m: number) =>
            `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          // A wall time swallowed by a spring-forward gap snaps to the jump.
          const isJump = (instant: Date) =>
            zoneOffsetMinutesAt(zone, instant.getTime() - 1) !==
            zoneOffsetMinutesAt(zone, instant.getTime());
          const wallOrJump = (instant: Date, minutes: number) =>
            isJump(instant) ||
            formatInTimeZone(instant, zone, "HH:mm") === clock(minutes);
          for (const interval of intervals) {
            expect(wallOrJump(interval.start, start)).toBe(true);
            expect(wallOrJump(interval.end, end)).toBe(true);
            expect(
              Number(formatInTimeZone(interval.start, zone, "i")) % 7,
            ).toBe(dayIndex);
          }
        },
      ),
      { numRuns: 400, seed: 872 },
    );
  });

  it("agrees with the coverage index", () => {
    const rows = [
      row("Europe/London", "SUNDAY", 0, 120),
      row("America/New_York", "SUNDAY", 60, 180),
    ];
    const coverage = createWeeklyCoverage(rows);
    for (const at of [
      "2026-10-25T00:30:00Z",
      "2026-11-01T06:00:00Z",
      "2026-11-01T07:30:00Z",
    ]) {
      const startMs = new Date(at).getTime();
      const expected = rows.some((r) =>
        isInstantWithinWeeklyRow(
          r,
          new Date(startMs),
          new Date(startMs + 1_800_000),
        ),
      );
      expect(coverage.covers(startMs, startMs + 1_800_000)).toBe(expected);
    }
  });
});

describe("no reader projects through the frozen offset", () => {
  const WRITERS = new Set([
    "app/api/scheduling/availability/weekly/route.ts",
    "app/api/scheduling/availability/weekly/[id]/route.ts",
    "app/api/scheduling/availability/weekly/zone/route.ts",
    "app/api/user/consultants/[id]/route.ts",
    "lib/scheduling/weeklyUtcOffset.ts",
    "prisma/seedFiles/5a-create-availability-windows.ts",
    "utils/onboarding-server.ts",
    "utils/scheduling-engine/mergeAdjacentWeeklyRows.ts",
  ]);
  const ROOTS = [
    "app",
    "components",
    "hooks",
    "jobs",
    "lib",
    "prisma",
    "schemas",
    "scripts",
    "types",
    "utils",
  ];

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "node_modules" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });

  it("mentions utcOffsetMinutes only in the writers", () => {
    const root = process.cwd();
    const readers = ROOTS.filter((r) => fs.existsSync(path.join(root, r)))
      .flatMap((r) => sourceFiles(path.join(root, r)))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((file) => !WRITERS.has(file))
      .filter((file) =>
        fs
          .readFileSync(path.join(root, file), "utf8")
          .includes("utcOffsetMinutes"),
      );
    expect(readers).toEqual([]);
  });
});
