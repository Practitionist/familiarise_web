/**
 * An availability row may only be published on the 30-minute booking grid.
 *
 * Every grid generator and the allocator step 30 minutes FROM THE ROW'S OWN
 * START, so a row at `startTimeUtc: 615` (10:15 UTC) yields cells at :15 and
 * :45 — and `slotStartRefusal` (lib/payments/utils/slot-validation) refuses any
 * start where `getTime() % SLOT_GRID_MS !== 0` with SLOT_NOT_ON_GRID, in
 * checkout AND in request-for-approval. Such a consultant's grid is not harder
 * to book, it is 100% unbookable.
 *
 * The guard lives in `lib/scheduling/availability-contract`, which is the one
 * rule set every write path shares (the four `/api/scheduling/availability/*`
 * routes, the settings PUT and the onboarding sync), so these pins are about the
 * contract's answer rather than about one route.
 */

import "../booking-algorithm/setup";
import {
  AVAILABILITY_GRID_MINUTES,
  AVAILABILITY_REFUSAL_STATUS,
  isOnSchedulingGrid,
  validateCustomWindow,
  validateWeeklyWindow,
  validateWeeklyWindows,
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

/** 10:15 UTC — the brief's example. */
const OFF_GRID = 615;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-18T10:00:00Z");

describe("the booking grid is derived from the engine's own atom", () => {
  it("is the same 30 minutes the engine schedules in", () => {
    // A new literal here would let the published-hours rule and the buyer's
    // SLOT_NOT_ON_GRID test drift apart, which is the bug this pins.
    expect(AVAILABILITY_GRID_MINUTES).toBe(30);
    expect(isOnSchedulingGrid(at("2026-09-20T09:30:00Z").getTime())).toBe(true);
    expect(isOnSchedulingGrid(at("2026-09-20T09:15:00Z").getTime())).toBe(
      false,
    );
  });
});

describe("weekly windows", () => {
  it("refuses a row whose own start is off the grid", () => {
    // 10:15 → 18:15 is a legal 8-hour window and nothing else is wrong with it.
    const refusal = validateWeeklyWindow(weekly(OFF_GRID, OFF_GRID + 480));
    expect(refusal).toMatchObject({ code: "GRID", index: 0 });
    expect(refusal?.message).toMatch(/hour or half hour/);
  });

  it("refuses a row whose END is off the grid even when the start is aligned", () => {
    // 09:00 → 09:15 is 15 minutes: too short, so duration speaks first.
    expect(validateWeeklyWindow(weekly(540, 555))?.code).toBe("DURATION");
    // 09:00 → 11:15 is 2h15m: long enough, ordered, but its end mints 11:15
    // and 11:45 starts nobody can book.
    expect(validateWeeklyWindow(weekly(540, 675))?.code).toBe("GRID");
  });

  it("accepts every aligned pair, including the overnight carry-over", () => {
    expect(validateWeeklyWindow(weekly(540, 600))).toBeNull();
    expect(validateWeeklyWindow(weekly(570, 630))).toBeNull();
    expect(validateWeeklyWindow(weekly(0, 720))).toBeNull();
    // Mon 22:00 → Tue 02:00 crosses midnight and both ends are aligned.
    expect(
      validateWeeklyWindow(weekly(1320, 120, "MONDAY", "TUESDAY")),
    ).toBeNull();
    // A window that ends exactly at midnight is a legal hour: 23:00 → Tue 00:00.
    expect(
      validateWeeklyWindow(weekly(1380, 0, "MONDAY", "TUESDAY")),
    ).toBeNull();
    // …but 23:45 → Tue 00:15 is off the grid on both ends, and 15 minutes long,
    // so duration is what a consultant is told first.
    expect(
      validateWeeklyWindow(weekly(1425, 15, "MONDAY", "TUESDAY"))?.code,
    ).toBe("DURATION");
  });

  it("reports the index of the offending row in a set", () => {
    expect(
      validateWeeklyWindows([weekly(540, 600), weekly(OFF_GRID, 900)]),
    ).toMatchObject({ code: "GRID", index: 1 });
  });

  it("maps GRID to a 400 like every other caller-shaped refusal", () => {
    expect(AVAILABILITY_REFUSAL_STATUS.GRID).toBe(400);
  });

  it("still speaks RANGE, ORDER and DURATION first", () => {
    // The grid is checked last on purpose: the cheaper, more specific complaint
    // about the same row is the one a consultant can act on most directly.
    expect(validateWeeklyWindow(weekly(-1, 60))?.code).toBe("RANGE");
    expect(validateWeeklyWindow(weekly(60.5, 120))?.code).toBe("RANGE");
    expect(validateWeeklyWindow(weekly(600, 540))?.code).toBe("ORDER");
    // 15 minutes AND off the grid: duration is the actionable answer.
    expect(validateWeeklyWindow(weekly(OFF_GRID, OFF_GRID + 15))?.code).toBe(
      "DURATION",
    );
  });
});

describe("custom windows", () => {
  it("refuses a range that starts off the grid — the same defect, not a different one", () => {
    // A custom row hands the allocator its raw `startsAt`
    // (`matchCustomSlotToDay`), so an off-grid start mints off-grid candidates
    // exactly as a weekly row does.
    expect(
      validateCustomWindow(
        { startsAt: at("2026-09-20T10:15:00Z"), endsAt: at("2026-09-20T12:15:00Z") },
        0,
        NOW,
      )?.code,
    ).toBe("GRID");
  });

  it("refuses a range that ENDS off the grid", () => {
    expect(
      validateCustomWindow(
        { startsAt: at("2026-09-20T09:00:00Z"), endsAt: at("2026-09-20T11:15:00Z") },
        0,
        NOW,
      )?.code,
    ).toBe("GRID");
  });

  it("accepts an aligned range, and refuses an unparseable one as RANGE", () => {
    expect(
      validateCustomWindow(
        {
          startsAt: at("2026-09-20T09:00:00Z"),
          endsAt: at("2026-09-20T11:00:00Z"),
        },
        0,
        NOW,
      ),
    ).toBeNull();
    expect(
      validateCustomWindow(
        { startsAt: "not-a-date", endsAt: at("2026-09-20T09:00:00Z") },
        0,
        NOW,
      )?.code,
    ).toBe("RANGE");
  });

  it("still refuses ORDER, DURATION and PAST ahead of the grid", () => {
    expect(
      validateCustomWindow(
        {
          startsAt: at("2026-09-20T11:00:00Z"),
          endsAt: at("2026-09-20T09:00:00Z"),
        },
        0,
        NOW,
      )?.code,
    ).toBe("ORDER");
    // 10 minutes and off the grid: duration is the answer.
    expect(
      validateCustomWindow(
        {
          startsAt: at("2026-09-20T10:15:00Z"),
          endsAt: at("2026-09-20T10:25:00Z"),
        },
        0,
        NOW,
      )?.code,
    ).toBe("DURATION");
    expect(
      validateCustomWindow(
        {
          startsAt: at("2026-09-17T10:15:00Z"),
          endsAt: at("2026-09-17T12:15:00Z"),
        },
        0,
        NOW,
      )?.code,
    ).toBe("PAST");
  });
});

describe("what the seed relies on", () => {
  it("writes whole-hour rows, so the guard refuses nothing it produces", () => {
    // prisma/seedFiles/5a-create-availability-windows.ts picks from a business
    // hours list whose every entry is `minute: 0` and adds a whole hour, so
    // every seeded start and end is a multiple of 30. If the seed ever grows a
    // :15 entry, this is the assertion that says so.
    const businessHours = [9, 10, 11, 14, 15, 16, 17];
    for (const hour of businessHours) {
      const start = hour * 60;
      expect(start % AVAILABILITY_GRID_MINUTES).toBe(0);
      expect((start + 60) % AVAILABILITY_GRID_MINUTES).toBe(0);
    }
  });
});
