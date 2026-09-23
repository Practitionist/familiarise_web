/**
 * @jest-environment node
 */

/**
 * #1785 L-4 — the booking calendar's day cells carry real state. The ring
 * needs at least one slot that is neither past nor fully booked (the
 * cal.diy#2329 rule), so a day whose every slot is taken earns nothing.
 */
import {
  dayState,
  durationDayMark,
  isSelectableDay,
  type DayMarkSlot,
} from "@/app/explore/experts/[consultantId]/day-state";
import { DayOfWeek } from "@prisma/client";
import type { TIntervalTiming } from "@/types/slots";

// A fixed Wednesday, 10:00 local time; the lead time is 15 minutes.
const NOW = new Date(2026, 9, 14, 10, 0, 0);
const TEST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (d: number) => new Date(2026, 9, d);
const at = (d: number, h: number, extra: Partial<DayMarkSlot> = {}) => ({
  startsAt: new Date(2026, 9, d, h, 0, 0).toISOString(),
  ...extra,
});

describe("dayState (#1785 L-4)", () => {
  it.each<[string, Date, DayMarkSlot[] | null, string]>([
    ["yesterday is past whatever it holds", day(13), [at(13, 15)], "past"],
    ["a day with no slots is none", day(20), [], "none"],
    [
      "a day whose every slot is taken is none",
      day(20),
      [at(20, 9, { bookingStatus: "fully-booked" })],
      "none",
    ],
    [
      "a day with one bookable slot is bookable",
      day(20),
      [at(20, 9, { bookingStatus: "fully-booked" }), at(20, 11)],
      "bookable",
    ],
    [
      "today with only elapsed slots is today+none",
      day(14),
      [at(14, 9), at(14, 10)],
      "today+none",
    ],
    [
      "today with a later slot is today+bookable",
      day(14),
      [at(14, 16)],
      "today+bookable",
    ],
    ["today without marks is today+unknown", day(14), null, "today+unknown"],
    ["a future day without marks is unknown", day(20), null, "unknown"],
  ])("%s", (_name, date, slots, expected) => {
    expect(dayState(date, NOW, slots)).toBe(expected);
  });

  it("lets a consultee pick anything but a past or known-empty day", () => {
    expect(isSelectableDay("bookable")).toBe(true);
    expect(isSelectableDay("unknown")).toBe(true);
    expect(isSelectableDay("past")).toBe(false);
    expect(isSelectableDay("none")).toBe(false);
    expect(isSelectableDay("today+none")).toBe(false);
  });
});

const halfHourSlot = (
  dayNumber: number,
  hour: number,
  minute: number,
  bookingStatus: "available" | "fully-booked" = "available",
): TIntervalTiming & { isAllocated: boolean } => {
  const start = new Date(2026, 9, dayNumber, hour, minute);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    slotId: `slot-${start.toISOString()}`,
    dateInISO: start.toISOString(),
    dayOfWeek: DayOfWeek.TUESDAY,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    availabilityWindowId: "window-1",
    appointmentOccurrenceId: "",
    localStartTime: start.toISOString().slice(11, 16),
    localEndTime: end.toISOString().slice(11, 16),
    isAllocated: bookingStatus === "fully-booked",
    bookingStatus,
    type: "WEEKLY",
  };
};

const durationDayState = (...args: Parameters<typeof durationDayMark>) =>
  durationDayMark(...args).state;

describe("durationDayMark", () => {
  const shortOpening = [halfHourSlot(20, 10, 0), halfHourSlot(20, 10, 30)];
  const twoHourOpening = [
    ...shortOpening,
    halfHourSlot(20, 11, 0),
    halfHourSlot(20, 11, 30),
  ];

  it("marks a day only when a window fits the selected plan length", () => {
    expect(
      durationDayState(
        day(20),
        NOW,
        shortOpening,
        1,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("bookable");
    expect(
      durationDayState(
        day(20),
        NOW,
        shortOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("none");
    expect(
      durationDayState(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("bookable");
  });

  it("does not promise a long window across an unavailable atom", () => {
    const brokenOpening = [
      ...shortOpening,
      halfHourSlot(20, 11, 0, "fully-booked"),
      halfHourSlot(20, 11, 30),
    ];
    expect(
      durationDayState(
        day(20),
        NOW,
        brokenOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("none");
  });

  it("respects request pauses and preserves unknown loading state", () => {
    expect(
      durationDayState(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "REQUEST",
        false,
      ),
    ).toBe("none");
    expect(
      durationDayState(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        false,
      ),
    ).toBe("bookable");
    expect(
      durationDayState(day(20), NOW, null, 2, TEST_TIMEZONE, "INSTANT", true),
    ).toBe("unknown");
  });

  it("distinguishes instant dates from approval-only dates", () => {
    expect(
      durationDayMark(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ).kind,
    ).toBe("instant");
    expect(
      durationDayMark(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "REQUEST",
        true,
      ).kind,
    ).toBe("request");
    expect(
      durationDayMark(
        day(20),
        NOW,
        twoHourOpening,
        2,
        TEST_TIMEZONE,
        "REQUEST",
        false,
      ).kind,
    ).toBeNull();

    const contended = {
      ...halfHourSlot(20, 11, 0),
      isAllocated: true,
      bookingStatus: "partially-booked" as const,
    };
    expect(
      durationDayMark(
        day(20),
        NOW,
        [contended],
        0.5,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ).kind,
    ).toBe("request");
    expect(
      durationDayMark(
        day(20),
        NOW,
        [halfHourSlot(20, 10, 0), contended],
        0.5,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ).kind,
    ).toBe("instant");
  });

  it("does not mark a duration window that starts inside the booking lead time", () => {
    const todayOpening = [
      halfHourSlot(14, 10, 0),
      halfHourSlot(14, 10, 30),
      halfHourSlot(14, 11, 0),
      halfHourSlot(14, 11, 30),
    ];
    expect(
      durationDayState(
        day(14),
        NOW,
        todayOpening,
        2,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("today+none");
    expect(
      durationDayState(
        day(14),
        NOW,
        todayOpening.slice(1),
        1,
        TEST_TIMEZONE,
        "INSTANT",
        true,
      ),
    ).toBe("today+bookable");
  });
});
