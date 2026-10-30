/**
 * #1785 L-4 — the booking calendar's day cells carry real state. The ring
 * needs at least one slot that is neither past nor fully booked (the
 * cal.diy#2329 rule), so a day whose every slot is taken earns nothing.
 */
import {
  dayState,
  isSelectableDay,
  type DayMarkSlot,
} from "@/app/explore/experts/[consultantId]/day-state";

// A fixed Wednesday, 10:00 local time; the lead time is 15 minutes.
const NOW = new Date(2026, 9, 14, 10, 0, 0);
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

  it("marks a day whose only free times are contended as bookable, like the list", () => {
    // The list offers a contended time as "Request"; the mark must agree.
    const contended = [at(20, 9, { isAllocated: true })];
    expect(dayState(day(20), NOW, contended)).toBe("bookable");
    const partly = [
      at(20, 9, { isAllocated: true, bookingStatus: "partially-booked" }),
    ];
    expect(dayState(day(20), NOW, partly)).toBe("bookable");
  });

  it("does not ring a day whose times are all too soon or over a plan limit", () => {
    expect(dayState(day(20), NOW, [at(20, 9, { tooSoon: true })])).toBe("none");
    expect(dayState(day(20), NOW, [at(20, 9, { limitReached: true })])).toBe(
      "none",
    );
  });

  it("reads today in the display zone, not the device's", () => {
    // 20:00 UTC on 14 Oct is already 15 Oct in Kolkata.
    const lateUtc = new Date("2026-10-14T20:00:00.000Z");
    expect(dayState(day(14), lateUtc, [], "Asia/Kolkata")).toBe("past");
    expect(dayState(day(15), lateUtc, null, "Asia/Kolkata")).toBe(
      "today+unknown",
    );
  });

  it("lets a consultee pick anything but a past or known-empty day", () => {
    expect(isSelectableDay("bookable")).toBe(true);
    expect(isSelectableDay("unknown")).toBe(true);
    expect(isSelectableDay("past")).toBe(false);
    expect(isSelectableDay("none")).toBe(false);
    expect(isSelectableDay("today+none")).toBe(false);
  });
});
