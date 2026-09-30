/**
 * @jest-environment node
 */

/**
 * "UTC" is a ZONE, not a mode — and it has to answer the same as every other
 * zone.
 *
 * `convertTimezoneToUtc` used to short-circuit `timezone === "UTC"` with
 * `new Date(`${dateStr}T${timeStr}:00`)`. An ES date-time form with no offset
 * designator is a LOCAL-TIME form: it is read in the host's own zone. So the one
 * branch whose name promised an absolute answer was the only branch that
 * depended on the machine — and every consultant whose profile timezone failed
 * to resolve landed in it, because the settings form and the onboarding wizard
 * both fall back to the literal string "UTC" (`timezone || "UTC"`). On a host
 * that is not UTC their whole week was published shifted by the host's offset,
 * and only on that host. Netlify runs TZ=UTC, so it was a landmine rather than
 * an outage, which is how it survived this long.
 *
 * What these pin is the INVARIANT, not a literal: the "UTC" answer must equal
 * what the general path computes for a genuinely zero-offset zone, and the UTC
 * minute-of-day it hands on must be the minute of day that was typed. A magic
 * ISO string would have passed on the CI host either way; these would not.
 */

import {
  convertTimezoneToUtc,
  convertTimezoneToUtcWithOvernight,
  convertUtcToTimezone,
} from "@/utils/dateTimeUtils";
import { weeklySlotForSave } from "@/utils/schedule/formatting";
import { dateToMinuteUtc } from "@/utils/scheduling-engine/slotTimeUtils";

/**
 * A real zero-offset zone that is NOT the special-cased string, so it can only
 * be answered by the general path. `lib/scheduling/weeklyUtcOffset.ts` already
 * treats Etc/UTC as a genuine zero-offset zone rather than a synonym to
 * single out, which is the precedent for reading it as the control here.
 */
const ZERO_OFFSET_ZONE = "Etc/UTC";

/** The calendar keys and wall clocks the availability write path carries. */
const DATES = ["1970-01-01", "2026-09-20", "2026-12-31"];
const TIMES = ["00:00", "00:15", "09:00", "12:30", "23:45"];
/** Every zone the two save paths can hand these functions, controls included. */
const ZONES = ["UTC", ZERO_OFFSET_ZONE, "Asia/Kolkata", "America/New_York"];

const minutesOfDay = (iso: string) => {
  const at = new Date(iso);
  return at.getUTCHours() * 60 + at.getUTCMinutes();
};

const minutesTyped = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** An overnight row as `formatCustomSlot` builds it: one date key, both times. */
const overnight = (
  startTime: string,
  endTime: string,
  dateStr: string,
  timezone: string,
) => ({
  startsAt: convertTimezoneToUtcWithOvernight(
    startTime,
    dateStr,
    timezone,
    false,
  ),
  endsAt: convertTimezoneToUtcWithOvernight(
    endTime,
    dateStr,
    timezone,
    true,
    startTime,
  ),
});

// ─── 1. The UTC branch IS the general path ──────────────────────────────────

describe('the "UTC" branch agrees with the general path', () => {
  it("answers identically to a real zero-offset zone", () => {
    for (const dateStr of DATES) {
      for (const timeStr of TIMES) {
        expect(convertTimezoneToUtc(timeStr, dateStr, "UTC")).toBe(
          convertTimezoneToUtc(timeStr, dateStr, ZERO_OFFSET_ZONE),
        );
      }
    }
  });

  it("publishes the minute that was typed, not the host's", () => {
    // The property the local-time parse broke: a host whose TZ is not UTC moved
    // the published UTC minute-of-day by the host's own offset. A weekly row
    // stores exactly this minute (`dateToMinuteUtc`), so the whole week moved
    // with it.
    for (const dateStr of DATES) {
      for (const timeStr of TIMES) {
        expect(
          minutesOfDay(convertTimezoneToUtc(timeStr, dateStr, "UTC")),
        ).toBe(minutesTyped(timeStr));
      }
    }
  });

  it("round-trips through its own inverse", () => {
    for (const timeStr of TIMES) {
      expect(
        convertUtcToTimezone(
          convertTimezoneToUtc(timeStr, DATES[1], "UTC"),
          "UTC",
        ),
      ).toBe(timeStr);
    }
  });

  it("says the same for the overnight twin", () => {
    for (const dateStr of DATES) {
      for (const timeStr of TIMES) {
        expect(
          convertTimezoneToUtcWithOvernight(timeStr, dateStr, "UTC", false),
        ).toBe(
          convertTimezoneToUtcWithOvernight(
            timeStr,
            dateStr,
            ZERO_OFFSET_ZONE,
            false,
          ),
        );
      }
    }
  });
});

// ─── 2. The shortcut may not be load-bearing ────────────────────────────────

describe("no zone is answered by a different rule from the others", () => {
  it("an unusable zone is still a failed conversion, not a silent zero", () => {
    // The refactor leans on this: `formatSlotsForApi` decides between "omit this
    // row" and "throw at the consultant" purely by whether it got "" (#1125),
    // and its suite pins that an unresolvable zone throws rather than saves less.
    expect(convertTimezoneToUtc("09:00", DATES[1], "Not/AZone")).toBe("");
    expect(
      convertTimezoneToUtcWithOvernight("09:00", DATES[1], "Not/AZone", false),
    ).toBe("");
  });

  it("a blank boundary is still a blank answer", () => {
    expect(convertTimezoneToUtc("", DATES[1], "UTC")).toBe("");
    expect(convertTimezoneToUtc("09:00", "", "UTC")).toBe("");
  });
});

// ─── 3. The overnight rollover is calendar arithmetic ───────────────────────

describe("an overnight end lands one day after its start", () => {
  // `new Date(dateStr)` is a UTC midnight — the date-only form is defined as
  // UTC — and the rollover used to read LOCAL fields off it and increment one
  // of those. On any host at or behind UTC the local day was already the day
  // before, so it handed the same date straight back and stamped an overnight
  // end on its own start's day. Expressed as a DURATION rather than a date, so
  // the pin does not itself depend on which day the key names.

  it("23:30 → 00:30 spans the hour it was typed as", () => {
    for (const timezone of ZONES) {
      const { startsAt, endsAt } = overnight("23:30", "00:30", DATES[1], timezone);
      expect(Date.parse(endsAt) - Date.parse(startsAt)).toBe(60 * 60 * 1000);
    }
  });

  it("22:00 → 01:00 spans the three hours it was typed as", () => {
    for (const timezone of ZONES) {
      const { startsAt, endsAt } = overnight("22:00", "01:00", DATES[1], timezone);
      expect(Date.parse(endsAt) - Date.parse(startsAt)).toBe(3 * 60 * 60 * 1000);
    }
  });

  it("and crosses the year with the key, not a 365-day jump", () => {
    const { startsAt, endsAt } = overnight("23:30", "00:30", DATES[2], "UTC");
    expect(Date.parse(endsAt) - Date.parse(startsAt)).toBe(60 * 60 * 1000);
    expect(endsAt.slice(0, 10)).not.toBe(startsAt.slice(0, 10));
  });

  it("a row that does not cross midnight is untouched by the rollover", () => {
    for (const timezone of ZONES) {
      const { startsAt, endsAt } = overnight("09:00", "17:00", DATES[1], timezone);
      expect(Date.parse(endsAt) - Date.parse(startsAt)).toBe(
        8 * 60 * 60 * 1000,
      );
    }
  });
});

// ─── 4. The write path the fallback actually feeds ──────────────────────────

describe("a consultant whose zone did not resolve publishes their own hours", () => {
  it("the weekly row stores the typed minutes when the fallback is \"UTC\"", () => {
    // `timezone || "UTC"` in `use-consultant-settings-form` and in the onboarding
    // wizard is the whole reason this branch was load-bearing, and a weekly row
    // carries nothing but this minute-of-day — so a host shift here is a
    // published availability nobody can book.
    const row = weeklySlotForSave(
      { startTime: "09:00", endTime: "17:00" },
      "monday",
      "UTC",
    );
    expect(row.startTimeUtc).toBe(minutesTyped("09:00"));
    expect(row.endTimeUtc).toBe(minutesTyped("17:00"));
    expect(dateToMinuteUtc(new Date(row.startsAtUtc))).toBe(row.startTimeUtc);
    expect(row.startDay).toBe("MONDAY");
  });
});
