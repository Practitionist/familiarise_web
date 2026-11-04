/**
 * A custom availability row is an absolute range that can span several days.
 * Auto search walks it as one slice per scheduling-zone day, clipped to the
 * row, so every day it covers is a candidate: the spacing rule, the daily cap,
 * the UTC half-hour lattice and daylight-saving days all hold inside it.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));
jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest.fn(),
  unlockAutoAllocate: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
}));

import type { PrismaLike } from "../../lib/prisma";
import { findAvailableSlots } from "../../lib/booking/allocation/search/find-available-slots";
import {
  customRowDaySlices,
  customSpansInStartOrder,
} from "../../lib/booking/allocation/search/recurrence";
import { ScheduleCalculationService } from "../../utils/scheduling-engine/ScheduleCalculationService";
import { ScheduleValidationService } from "../../utils/scheduling-engine/ScheduleValidationService";
import type {
  ConsultantAllocationData,
  EventConfig,
  EventType,
} from "../../utils/scheduling-engine/types";

const IST = "Asia/Kolkata";
const KATHMANDU = "Asia/Kathmandu";
const LONDON = "Europe/London";
const ATOM_MS = 30 * 60 * 1000;

const at = (iso: string) => new Date(iso);

function customConsultant(
  rows: { startsAt: string; endsAt: string }[],
): ConsultantAllocationData {
  return {
    userId: "consultant-user",
    scheduleType: "CUSTOM",
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: rows.map((row, i) => ({
      id: `custom-${i}`,
      startsAt: at(row.startsAt),
      endsAt: at(row.endsAt),
    })),
  };
}

/** One-hour sessions (two atoms each); `held` atoms count as booked. */
const place = (
  consultant: ConsultantAllocationData,
  config: EventConfig,
  sessions: number,
  eventType: EventType = "subscription",
  held: string[] = [],
) =>
  findAvailableSlots(
    {
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaLike,
    consultant,
    sessions * 2,
    2,
    eventType,
    config,
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    [],
    held,
  );

/** Session starts (every other atom, since sessions are one hour). */
const sessionStarts = (slots: Date[]) =>
  slots.filter((_, i) => i % 2 === 0).map((s) => s.toISOString());

const dayKeys = (slots: Date[], zone: string) =>
  slots
    .filter((_, i) => i % 2 === 0)
    .map((s) => ScheduleCalculationService.dayKey(s, zone));

/** Every atom start in [fromIso, toIso). */
const atomsBetween = (fromIso: string, toIso: string) => {
  const atoms: string[] = [];
  for (let ms = Date.parse(fromIso); ms < Date.parse(toIso); ms += ATOM_MS) {
    atoms.push(new Date(ms).toISOString());
  }
  return atoms;
};

const sliceIsos = (slices: { start: Date; endMs: number }[]) =>
  slices.map((s) => [s.start.toISOString(), new Date(s.endMs).toISOString()]);

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-08-08T12:00:00Z"));
});
afterAll(() => jest.useRealTimers());

// Fri 14 Aug 2026 18:00 IST to Mon 17 Aug 10:00 IST.
const IST_WEEKEND_ROW = {
  startsAt: "2026-08-14T12:30:00.000Z",
  endsAt: "2026-08-17T04:30:00.000Z",
};
// Fri 14 Aug 00:00 IST to Fri 21 Aug 00:00 IST.
const istWeek = (sessionsPerWeek: number): EventConfig => ({
  sessionsPerWeek,
  sessionDurationInHours: 1,
  schedulingPeriodStartsAt: at("2026-08-13T18:30:00.000Z"),
  schedulingPeriodEndsAt: at("2026-08-20T18:30:00.000Z"),
  schedulingTimezone: IST,
});

describe("customRowDaySlices", () => {
  it("cuts a three-day row at each zone midnight, clipped to the row", () => {
    expect(
      sliceIsos(
        customRowDaySlices(
          {
            startsAt: at(IST_WEEKEND_ROW.startsAt),
            endsAt: at(IST_WEEKEND_ROW.endsAt),
          },
          IST,
        ),
      ),
    ).toEqual([
      ["2026-08-14T12:30:00.000Z", "2026-08-14T18:30:00.000Z"],
      ["2026-08-14T18:30:00.000Z", "2026-08-15T18:30:00.000Z"],
      ["2026-08-15T18:30:00.000Z", "2026-08-16T18:30:00.000Z"],
      ["2026-08-16T18:30:00.000Z", "2026-08-17T04:30:00.000Z"],
    ]);
  });

  it("leaves a row inside one day whole", () => {
    expect(
      sliceIsos(
        customRowDaySlices(
          {
            startsAt: at("2026-08-14T04:30:00.000Z"),
            endsAt: at("2026-08-14T08:30:00.000Z"),
          },
          IST,
        ),
      ),
    ).toEqual([["2026-08-14T04:30:00.000Z", "2026-08-14T08:30:00.000Z"]]);
  });

  it("cuts a :45 zone on the half-hour lattice, so the atom across midnight stays", () => {
    // Kathmandu is +05:45: Sun 00:00 is Sat 18:15Z, off the lattice. The atom
    // 18:00Z–18:30Z starts on Saturday (23:45) and must stay in Saturday's slice.
    const slices = customRowDaySlices(
      {
        startsAt: at("2026-08-15T14:30:00.000Z"),
        endsAt: at("2026-08-17T03:30:00.000Z"),
      },
      KATHMANDU,
    );
    expect(sliceIsos(slices)).toEqual([
      ["2026-08-15T14:30:00.000Z", "2026-08-15T18:30:00.000Z"],
      ["2026-08-15T18:30:00.000Z", "2026-08-16T18:30:00.000Z"],
      ["2026-08-16T18:30:00.000Z", "2026-08-17T03:30:00.000Z"],
    ]);
  });

  it("gives the fall-back Sunday its 25 hours", () => {
    // London leaves BST at 02:00 on Sun 25 Oct 2026: Sunday runs from Sat
    // 23:00Z to Mon 00:00Z.
    const slices = customRowDaySlices(
      {
        startsAt: at("2026-10-24T17:00:00.000Z"),
        endsAt: at("2026-10-26T10:00:00.000Z"),
      },
      LONDON,
    );
    expect(sliceIsos(slices)).toEqual([
      ["2026-10-24T17:00:00.000Z", "2026-10-24T23:00:00.000Z"],
      ["2026-10-24T23:00:00.000Z", "2026-10-26T00:00:00.000Z"],
      ["2026-10-26T00:00:00.000Z", "2026-10-26T10:00:00.000Z"],
    ]);
    expect(slices[1].endMs - slices[1].start.getTime()).toBe(25 * 3_600_000);
  });
});

describe("customSpansInStartOrder", () => {
  it("slices only what overlaps the window, clipping a long row to it", () => {
    // A two-year coalesced row walked over one IST week yields seven slices.
    const spans = [
      ...customSpansInStartOrder(
        [
          {
            startsAt: at("2026-01-01T00:00:00.000Z"),
            endsAt: at("2028-01-01T00:00:00.000Z"),
          },
          {
            startsAt: at("2027-03-01T04:30:00.000Z"),
            endsAt: at("2027-03-01T08:30:00.000Z"),
          },
        ],
        IST,
        {
          startMs: Date.parse("2026-08-13T18:30:00.000Z"),
          endMs: Date.parse("2026-08-20T18:30:00.000Z"),
        },
      ),
    ];
    expect(spans).toHaveLength(7);
    expect(spans[0].start.toISOString()).toBe("2026-08-13T18:30:00.000Z");
    expect(new Date(spans[6].endMs).toISOString()).toBe(
      "2026-08-20T18:30:00.000Z",
    );
  });
});

describe("auto search inside one multi-day custom row", () => {
  it("keeps a free day between two sessions across the row's days", async () => {
    const slots = await place(
      customConsultant([IST_WEEKEND_ROW]),
      istWeek(2),
      2,
    );
    // Friday 18:00, then Sunday 00:00: Saturday is skipped for the spacing rule.
    expect(dayKeys(slots, IST)).toEqual(["2026-08-14", "2026-08-16"]);
    expect(sessionStarts(slots)).toEqual([
      "2026-08-14T12:30:00.000Z",
      "2026-08-15T18:30:00.000Z",
    ]);
  });

  it("places 3 a week on three covered days: spaced first, then packed", async () => {
    const slots = await place(
      customConsultant([IST_WEEKEND_ROW]),
      istWeek(3),
      3,
    );
    // Friday and Sunday keep the free day; the third packs onto Saturday.
    expect(dayKeys(slots, IST)).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("offers the row's in-period days when the row began before the period", async () => {
    // The plan starts Mon 17 Aug 08:00 IST (02:30Z). The row's Monday slice
    // began on the previous UTC day, before the walk's first day.
    const slots = await place(
      customConsultant([IST_WEEKEND_ROW]),
      {
        ...istWeek(1),
        schedulingPeriodStartsAt: at("2026-08-17T02:30:00.000Z"),
        schedulingPeriodEndsAt: at("2026-08-24T02:30:00.000Z"),
      },
      1,
    );
    expect(sessionStarts(slots)).toEqual(["2026-08-17T02:30:00.000Z"]);
  });

  it("keeps lattice-aligned starts in a :45 zone and reaches the row's last day", async () => {
    // Sat 15 Aug 20:15 to Mon 17 Aug 09:15 in Kathmandu.
    const slots = await place(
      customConsultant([
        {
          startsAt: "2026-08-15T14:30:00.000Z",
          endsAt: "2026-08-17T03:30:00.000Z",
        },
      ]),
      {
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
        schedulingPeriodStartsAt: at("2026-08-14T18:15:00.000Z"),
        schedulingPeriodEndsAt: at("2026-08-21T18:15:00.000Z"),
        schedulingTimezone: KATHMANDU,
      },
      2,
    );
    expect(slots.every((s) => s.getTime() % ATOM_MS === 0)).toBe(true);
    // Saturday 20:15, then Monday 00:15 (the first lattice start after midnight).
    expect(dayKeys(slots, KATHMANDU)).toEqual(["2026-08-15", "2026-08-17"]);
    expect(sessionStarts(slots)).toEqual([
      "2026-08-15T14:30:00.000Z",
      "2026-08-16T18:30:00.000Z",
    ]);
  });

  describe("across the London fall-back night", () => {
    const londonRow = customConsultant([
      {
        startsAt: "2026-10-24T17:00:00.000Z",
        endsAt: "2026-10-26T10:00:00.000Z",
      },
    ]);
    const londonWeek: EventConfig = {
      sessionsPerWeek: 3,
      sessionDurationInHours: 1,
      schedulingPeriodStartsAt: at("2026-10-23T23:00:00.000Z"),
      schedulingPeriodEndsAt: at("2026-10-30T23:00:00.000Z"),
      schedulingTimezone: LONDON,
    };

    it("places on Saturday, Sunday and Monday by London days", async () => {
      const slots = await place(londonRow, londonWeek, 3);
      expect(dayKeys(slots, LONDON)).toEqual([
        "2026-10-24",
        "2026-10-25",
        "2026-10-26",
      ]);
      // Sunday 00:00 is still BST (Sat 23:00Z); Monday 00:00 is GMT.
      expect(sessionStarts(slots)).toEqual([
        "2026-10-24T17:00:00.000Z",
        "2026-10-24T23:00:00.000Z",
        "2026-10-26T00:00:00.000Z",
      ]);
    });

    it("reaches the 25th hour of the fall-back Sunday", async () => {
      // Sunday's first 24 hours are taken; only 23:00–24:00 GMT is left.
      const held = atomsBetween(
        "2026-10-24T23:00:00.000Z",
        "2026-10-25T23:00:00.000Z",
      );
      const slots = await place(londonRow, londonWeek, 3, "subscription", held);
      expect(sessionStarts(slots)).toEqual([
        "2026-10-24T17:00:00.000Z",
        "2026-10-25T23:00:00.000Z",
        "2026-10-26T00:00:00.000Z",
      ]);
    });
  });

  it("places a consultation on a later day of the row when its first day is taken", async () => {
    // Friday 18:00 IST to Saturday 19:00 IST is held: more than 25 hours, so
    // only a walk that reaches past the row's first day finds a time.
    const held = atomsBetween(
      "2026-08-14T12:30:00.000Z",
      "2026-08-15T13:30:00.000Z",
    );
    const slots = await place(
      customConsultant([IST_WEEKEND_ROW]),
      { sessionDurationInHours: 1, schedulingTimezone: IST },
      1,
      "consultation",
      held,
    );
    expect(sessionStarts(slots)).toEqual(["2026-08-15T13:30:00.000Z"]);
  });
});

describe("the validator already accepts these placements", () => {
  const service = new ScheduleValidationService({
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
  } as never);
  const validate = (slots: Date[]) =>
    service.validate(
      "consultation",
      "c-1",
      slots,
      customConsultant([IST_WEEKEND_ROW]),
      { durationInHours: 1 },
      [],
    );

  it("accepts a session on the row's last day", async () => {
    // Mon 17 Aug 08:00–09:00 IST, inside the row's final slice.
    const result = await validate([
      at("2026-08-17T02:30:00.000Z"),
      at("2026-08-17T03:00:00.000Z"),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("refuses a session just past the row's end", async () => {
    // Mon 17 Aug 10:00–11:00 IST: the row ends at 10:00.
    const result = await validate([
      at("2026-08-17T04:30:00.000Z"),
      at("2026-08-17T05:00:00.000Z"),
    ]);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/^\[OUTSIDE_AVAILABILITY\]/);
  });
});
