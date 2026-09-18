/**
 * Pins lib/scheduling/availability-contract — the one rule set every
 * availability write path shares (onboarding sync, per-row routes, settings
 * PUT). Each refusal code has one row here; a rule that moves must move a pin.
 */

// slotTimeUtils loads @prisma/client for the DayOfWeek enum; jsdom lacks
// TextEncoder, which the client's runtime touches at import.
import "../booking-algorithm/setup";
import {
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  validateCustomWindows,
  validateWeeklyWindow,
  validateWeeklyWindows,
  AvailabilityContractError,
  assertWeeklyWindows,
} from "../../lib/scheduling/availability-contract";

const weekly = (
  startTimeUtc: number,
  endTimeUtc: number,
  startDay = "MONDAY",
  endDay = startDay,
) =>
  ({
    startDay,
    endDay,
    startTimeUtc,
    endTimeUtc,
  }) as Parameters<typeof validateWeeklyWindow>[0];

describe("weekly windows", () => {
  it("accepts the bounds exactly (30 min and 12 h)", () => {
    expect(
      validateWeeklyWindow(weekly(540, 540 + MIN_WINDOW_MINUTES)),
    ).toBeNull();
    expect(validateWeeklyWindow(weekly(0, MAX_WINDOW_MINUTES))).toBeNull();
  });

  it("refuses too short and too long with DURATION", () => {
    expect(validateWeeklyWindow(weekly(540, 555))?.code).toBe("DURATION");
    expect(validateWeeklyWindow(weekly(0, MAX_WINDOW_MINUTES + 30))?.code).toBe(
      "DURATION",
    );
  });

  it("refuses minutes outside 0–1439 with RANGE", () => {
    expect(validateWeeklyWindow(weekly(-1, 60))?.code).toBe("RANGE");
    expect(validateWeeklyWindow(weekly(60, 1440))?.code).toBe("RANGE");
    expect(validateWeeklyWindow(weekly(60.5, 120))?.code).toBe("RANGE");
  });

  it("refuses a same-day window that ends before it starts with ORDER", () => {
    expect(validateWeeklyWindow(weekly(600, 540))?.code).toBe("ORDER");
  });

  it("accepts an overnight window and measures it across midnight", () => {
    // Mon 22:00 → Tue 02:00 = 4 h
    expect(
      validateWeeklyWindow(weekly(1320, 120, "MONDAY", "TUESDAY")),
    ).toBeNull();
    // Mon 23:45 → Tue 00:00 = 15 min
    expect(
      validateWeeklyWindow(weekly(1425, 0, "MONDAY", "TUESDAY"))?.code,
    ).toBe("DURATION");
  });

  it("refuses an empty set unless the caller allows it", () => {
    expect(validateWeeklyWindows([])?.code).toBe("EMPTY");
    expect(validateWeeklyWindows([], { allowEmpty: true })).toBeNull();
  });

  it("refuses overlap but allows back-to-back", () => {
    expect(
      validateWeeklyWindows([weekly(540, 660), weekly(600, 720)])?.code,
    ).toBe("OVERLAP");
    expect(
      validateWeeklyWindows([weekly(540, 600), weekly(600, 660)]),
    ).toBeNull();
  });

  it("reports the index of the offending window", () => {
    const refusal = validateWeeklyWindows([weekly(540, 600), weekly(600, 605)]);
    expect(refusal).toMatchObject({ code: "DURATION", index: 1 });
  });

  it("assert* throws a typed error with the code", () => {
    expect(() => assertWeeklyWindows([])).toThrow(AvailabilityContractError);
    expect(() => assertWeeklyWindows([weekly(540, 555)])).toThrow(
      expect.objectContaining({ code: "DURATION" }),
    );
  });
});

describe("custom windows", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  const at = (iso: string) => new Date(iso);

  it("accepts a future window inside the bounds", () => {
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-20T09:00:00Z"),
            endsAt: at("2026-09-20T11:00:00Z"),
          },
        ],
        { now },
      ),
    ).toBeNull();
  });

  it("refuses ORDER, DURATION, RANGE and PAST", () => {
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-20T11:00:00Z"),
            endsAt: at("2026-09-20T09:00:00Z"),
          },
        ],
        { now },
      )?.code,
    ).toBe("ORDER");
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-20T09:00:00Z"),
            endsAt: at("2026-09-20T09:10:00Z"),
          },
        ],
        { now },
      )?.code,
    ).toBe("DURATION");
    expect(
      validateCustomWindows(
        [{ startsAt: "not-a-date", endsAt: "2026-09-20T09:00:00Z" }],
        {
          now,
        },
      )?.code,
    ).toBe("RANGE");
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-17T09:00:00Z"),
            endsAt: at("2026-09-17T11:00:00Z"),
          },
        ],
        { now },
      )?.code,
    ).toBe("PAST");
  });

  it("keeps a window that is in progress right now", () => {
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-18T09:00:00Z"),
            endsAt: at("2026-09-18T11:00:00Z"),
          },
        ],
        { now },
      ),
    ).toBeNull();
  });

  it("refuses overlap, allows back-to-back, refuses empty", () => {
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-20T09:00:00Z"),
            endsAt: at("2026-09-20T11:00:00Z"),
          },
          {
            startsAt: at("2026-09-20T10:00:00Z"),
            endsAt: at("2026-09-20T12:00:00Z"),
          },
        ],
        { now },
      )?.code,
    ).toBe("OVERLAP");
    expect(
      validateCustomWindows(
        [
          {
            startsAt: at("2026-09-20T09:00:00Z"),
            endsAt: at("2026-09-20T11:00:00Z"),
          },
          {
            startsAt: at("2026-09-20T11:00:00Z"),
            endsAt: at("2026-09-20T12:00:00Z"),
          },
        ],
        { now },
      ),
    ).toBeNull();
    expect(validateCustomWindows([], { now })?.code).toBe("EMPTY");
  });
});
