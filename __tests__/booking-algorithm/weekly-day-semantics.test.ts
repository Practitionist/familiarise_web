/**
 * @jest-environment node
 */

/**
 * One rule, pinned from every side: `startDay` is the day the CONSULTANT
 * published in their own calendar, and every surface projects a weekly row
 * from its local columns in its own zone.
 */

import fs from "fs";
import path from "path";

import {
  buildWeeklySlotsForSave,
  formatSlotsForApi,
  weeklySlotForSave,
  type WeeklySlotApiFormat,
} from "../../utils/schedule/formatting";
import {
  LAUNCH_TIMEZONE,
  LAUNCH_UTC_OFFSET_MINUTES,
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  WeeklyOffsetConflictError,
  weeklyLocalColumnsForSave,
} from "../../lib/scheduling/weeklyUtcOffset";
import { getTimezoneOffsetMinutes } from "../../utils/scheduling-engine/slotTimeUtils";
import {
  weeklyRowIntervalsInRange,
  weeklyRowLocalColumns,
} from "../../utils/schedule/weekly-projection";
import {
  findUncoveredAtom,
  windowAtoms,
} from "../../utils/scheduling-engine/availabilityCoverage";
import {
  processAvailabilitySlots,
  type WeeklySlot,
} from "../../utils/scheduling-engine/intervals";

const IST = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

/** IST Monday 01:00–05:00 — the row every day-shift bug was reported on. */
const IST_EARLY_MONDAY: WeeklySlot = {
  id: "row-early-monday",
  timezone: IST,
  localStartDay: "MONDAY",
  localStartMinutes: 60,
  localEndMinutes: 300,
  localEndDay: "MONDAY",
};

// ─── 1. The two save paths agree on startDay (#1343) ────────────────────────

describe("the two weekly save paths agree on startDay (#1343)", () => {
  const cases = [
    {
      name: "Asia/Kolkata wednesday 05:00–06:00",
      timezone: IST,
      dayKey: "wednesday",
      slot: { startTime: "05:00", endTime: "06:00", isValid: true },
      expectedStartDay: "WEDNESDAY",
    },
    {
      name: "Asia/Kolkata monday 01:00–05:00 (before the offset)",
      timezone: IST,
      dayKey: "monday",
      slot: { startTime: "01:00", endTime: "05:00", isValid: true },
      expectedStartDay: "MONDAY",
    },
    {
      name: "America/New_York monday 23:00–23:30",
      timezone: NEW_YORK,
      dayKey: "monday",
      slot: { startTime: "23:00", endTime: "23:30", isValid: true },
      expectedStartDay: "MONDAY",
    },
  ];

  it.each(cases)(
    "$name stores the local day on both paths",
    ({ timezone, dayKey, slot, expectedStartDay }) => {
      const [onboardingRow] = buildWeeklySlotsForSave(
        { [dayKey]: [slot] },
        timezone,
      );
      const [settingsRow] = formatSlotsForApi(
        { [dayKey]: [slot] },
        true,
        timezone,
      ) as WeeklySlotApiFormat[];

      expect(onboardingRow.startDay).toBe(expectedStartDay);
      expect(settingsRow.dayOfWeekforStartTimeInUTC).toBe(expectedStartDay);
      expect(settingsRow.dayOfWeekforEndTimeInUTC).toBe(onboardingRow.endDay);
    },
  );

  it("is idempotent: re-saving the day the settings form loaded does not move it", () => {
    // The settings loader keys its form rows by the stored startDay, so a save
    // of an untouched form must return the same day. It used to walk back one
    // weekday per save for every IST row starting before 05:30.
    let dayKey = "monday";
    for (let save = 0; save < 3; save++) {
      const row = weeklySlotForSave(
        { startTime: "01:00", endTime: "05:00" },
        dayKey,
        IST,
      );
      expect(row.startDay).toBe("MONDAY");
      dayKey = row.startDay.toLowerCase();
    }
  });
});

// ─── 2. One offset resolver on every write path (#1326, #1348) ──────────────

describe("resolveWeeklyUtcOffsetMinutes (#1326)", () => {
  it.each([
    ["no profile timezone", null, LAUNCH_UTC_OFFSET_MINUTES],
    ["an empty profile timezone", "", LAUNCH_UTC_OFFSET_MINUTES],
    [LAUNCH_TIMEZONE, LAUNCH_TIMEZONE, LAUNCH_UTC_OFFSET_MINUTES],
    // A junk zone resolves to 0 through Intl, which is indistinguishable from
    // Greenwich — it must fall back to the launch offset, never to UTC.
    ["an unresolvable timezone", "Not/AZone", LAUNCH_UTC_OFFSET_MINUTES],
  ])("%s resolves to %s", (_name, profileTimezone, expected) => {
    expect(resolveWeeklyUtcOffsetMinutes({ profileTimezone })).toBe(expected);
  });

  it("uses the real offset for a consultant outside the launch zone", () => {
    expect(resolveWeeklyUtcOffsetMinutes({ profileTimezone: NEW_YORK })).toBe(
      getTimezoneOffsetMinutes(NEW_YORK),
    );
  });

  it("keeps a genuinely zero-offset zone at zero", () => {
    expect(resolveWeeklyUtcOffsetMinutes({ profileTimezone: "UTC" })).toBe(0);
  });

  it("rejects a caller-supplied offset that contradicts the profile", () => {
    expect(() =>
      resolveWeeklyUtcOffsetMinutes({
        profileTimezone: IST,
        callerSupplied: 0,
      }),
    ).toThrow(WeeklyOffsetConflictError);
    expect(
      resolveWeeklyUtcOffsetMinutes({
        profileTimezone: IST,
        callerSupplied: LAUNCH_UTC_OFFSET_MINUTES,
      }),
    ).toBe(LAUNCH_UTC_OFFSET_MINUTES);
  });

  it("stamps the launch zone when the profile has none", () => {
    expect(resolveWeeklyTimezone(null)).toBe(LAUNCH_TIMEZONE);
    expect(resolveWeeklyTimezone("Not/AZone")).toBe(LAUNCH_TIMEZONE);
    expect(resolveWeeklyTimezone(NEW_YORK)).toBe(NEW_YORK);
  });

  it.each([
    "utils/onboarding-server.ts",
    "app/api/scheduling/availability/weekly/route.ts",
    "app/api/scheduling/availability/weekly/[id]/route.ts",
    "app/api/user/consultants/[id]/route.ts",
  ])("%s resolves the offset through the shared resolver", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).toContain("resolveWeeklyUtcOffsetMinutes(");
    // Each of these once derived the offset itself, and two of them defaulted
    // a missing profile timezone to UTC 0.
    expect(source).not.toContain("getTimezoneOffsetMinutes(");
  });
});

// ─── 3. The grid and the validator agree (#1342) ────────────────────────────

describe("the grid and the validator project a weekly row identically", () => {
  const rangeStart = new Date("2026-09-06T00:00:00.000Z");
  const rangeEnd = new Date("2026-09-13T00:00:00.000Z");

  it("puts an IST Monday 01:00 row on the UTC Sunday instant that owns it", () => {
    const occurrences = weeklyRowIntervalsInRange(
      IST_EARLY_MONDAY,
      rangeStart,
      rangeEnd,
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].start.toISOString()).toBe("2026-09-06T19:30:00.000Z");
    expect(occurrences[0].end.toISOString()).toBe("2026-09-06T23:30:00.000Z");
  });

  it("offers only atoms the checkout validator accepts", () => {
    const occurrences = weeklyRowIntervalsInRange(
      IST_EARLY_MONDAY,
      rangeStart,
      rangeEnd,
    );
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(
        findUncoveredAtom(
          windowAtoms(occurrence.start, occurrence.end),
          [IST_EARLY_MONDAY],
          [],
        ),
      ).toBeNull();
    }
  });

  it("shows the same instants to an IST viewer and a New York viewer", () => {
    const startsFor = (timezone: string) =>
      Object.values(
        processAvailabilitySlots(
          [IST_EARLY_MONDAY],
          [],
          [],
          rangeStart,
          rangeEnd,
          timezone,
        ),
      )
        .flat()
        .map((slot) => slot.startsAt)
        .sort();

    const istStarts = startsFor(IST);
    expect(istStarts).toContain("2026-09-06T19:30:00.000Z");
    expect(istStarts).toHaveLength(8); // four hours of 30-minute atoms
    expect(startsFor(NEW_YORK)).toEqual(istStarts);
  });
});

// ─── 4. Day segments are half-open (#1415) ──────────────────────────────────

describe("a block ending at local midnight keeps its last atom (#1415)", () => {
  // IST Monday 22:00 → Tuesday 00:00 = UTC Monday 16:30 → 18:30.
  const lateBlock: WeeklySlot = {
    id: "row-late-monday",
    timezone: IST,
    localStartDay: "MONDAY",
    localStartMinutes: 1320,
    localEndMinutes: 0,
    localEndDay: "TUESDAY",
  };
  const rangeStart = new Date("2026-09-07T00:00:00.000Z"); // Monday
  const rangeEnd = new Date("2026-09-08T00:00:00.000Z");

  it("still offers the 23:30 window", () => {
    const slots = Object.values(
      processAvailabilitySlots([lateBlock], [], [], rangeStart, rangeEnd, IST),
    ).flat();
    expect(slots.map((slot) => slot.startsAt)).toContain(
      "2026-09-07T18:00:00.000Z",
    );
  });
});

// ─── 5. The dual-written DST columns ────────────────────────────────────────

describe("weeklyRowLocalColumns", () => {
  it("describes an IST pre-dawn row in the consultant's own wall clock", () => {
    expect(
      weeklyRowLocalColumns(
        {
          startDay: "MONDAY",
          endDay: "MONDAY",
          startTimeUtc: 1170,
          endTimeUtc: 1410,
        },
        IST,
        330,
      ),
    ).toEqual({
      timezone: IST,
      localStartMinutes: 60, // 01:00
      localEndMinutes: 300, // 05:00
      localStartDay: "MONDAY",
      localEndDay: "MONDAY",
    });
  });

  it("carries the local end onto the next day when the row crosses local midnight", () => {
    // IST Monday 22:00 → Tuesday 00:00 is same-day in UTC, so `endDay` says
    // MONDAY; locally it ends on Tuesday.
    expect(
      weeklyRowLocalColumns(
        {
          startDay: "MONDAY",
          endDay: "MONDAY",
          startTimeUtc: 990,
          endTimeUtc: 1110,
        },
        IST,
        330,
      ),
    ).toEqual({
      timezone: IST,
      localStartMinutes: 1320, // 22:00
      localEndMinutes: 0, // 00:00
      localStartDay: "MONDAY",
      localEndDay: "TUESDAY",
    });
  });
});

describe("the save path's local columns are what the consultant typed", () => {
  it.each([NEW_YORK, "Europe/London", "Australia/Sydney", IST])(
    "%s 09:00–12:00 Monday stays 09:00–12:00 whatever the season",
    (timezone) => {
      const row = weeklySlotForSave(
        { startTime: "09:00", endTime: "12:00" },
        "monday",
        timezone,
      );
      expect(weeklyLocalColumnsForSave(row, timezone)).toEqual({
        timezone,
        localStartMinutes: 540,
        localEndMinutes: 720,
        localStartDay: "MONDAY",
        localEndDay: "MONDAY",
      });
    },
  );
});
