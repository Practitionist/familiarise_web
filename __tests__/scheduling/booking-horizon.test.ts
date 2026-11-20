/**
 * A 1:1 session may start at most 90 days ahead. The grid route flags later
 * cells; every picker reads the flag as "not bookable" through its one model.
 */
import {
  isBeyondBookingHorizon,
  MAX_BOOKING_HORIZON_DAYS,
} from "@/lib/booking/lead-time";
import {
  isBookableWindow,
  windowsForDay,
} from "@/lib/scheduling/booking-windows";
import { buildDayList } from "@/lib/scheduling/day-list";
import {
  BUYER_LEGEND_KEYS,
  CONSULTANT_LEGEND_KEYS,
  SLOT_STATUS_TOKENS,
} from "@/lib/scheduling/interval-status-tokens";
import {
  atomIsFree,
  describeAtom,
  type AtomContext,
} from "@/lib/scheduling/week-grid-model";

const ATOM = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 7, 9, 50);
const T = Date.UTC(2026, 11, 6, 10, 0);

describe("the booking horizon", () => {
  it("is 90 days, and a start exactly on it is still inside", () => {
    expect(MAX_BOOKING_HORIZON_DAYS).toBe(90);
    expect(isBeyondBookingHorizon(NOW + 90 * DAY, NOW)).toBe(false);
    expect(isBeyondBookingHorizon(NOW + 90 * DAY + 1, NOW)).toBe(true);
  });

  it("has its own non-selectable state that says when bookings open", () => {
    const token = SLOT_STATUS_TOKENS.beyondHorizon;
    expect(token.interactive).toBe(false);
    expect(token.hint).toBe("Bookings open up to 90 days ahead.");
    expect(token.pattern ?? token.icon).toBeTruthy();
    expect(BUYER_LEGEND_KEYS).toContain("beyondHorizon");
    expect(CONSULTANT_LEGEND_KEYS).toContain("beyondHorizon");
  });

  it("paints a flagged free cell with that state on the week grid, and it is not free", () => {
    const none = new Set<number>();
    const ctx: AtomContext = {
      serverCells: new Map([
        [
          T,
          {
            startMs: T,
            endMs: T + ATOM,
            bookingStatus: "available",
            tooSoon: false,
            limitReached: false,
            beyondHorizon: true,
            overlappingAppointments: [],
          },
        ],
      ]),
      eventStarts: none,
      tentativeStarts: none,
      selectedStarts: none,
      justTakenStarts: none,
      requestedStarts: none,
      nowMs: NOW,
    };
    const atom = describeAtom(T, T + ATOM, ctx);
    expect(atom.statusKey).toBe("beyondHorizon");
    expect(atomIsFree(atom)).toBe(false);
  });

  it("is not a window the buyer's pickers offer", () => {
    const atoms = [
      { startsAt: new Date(T).toISOString(), beyondHorizon: true },
      { startsAt: new Date(T + ATOM).toISOString() },
      { startsAt: new Date(T + 2 * ATOM).toISOString() },
    ];
    const bookable = windowsForDay(atoms, 1, "UTC", NOW)
      .filter(isBookableWindow)
      .map((w) => w.startsAt);
    expect(bookable).toEqual([new Date(T + ATOM).toISOString()]);
  });

  it("judges a window by its start, as the booking doors do", () => {
    // T starts exactly on the horizon; the half-hours after it are past it.
    const atoms = [
      { startsAt: new Date(T).toISOString() },
      { startsAt: new Date(T + ATOM).toISOString(), beyondHorizon: true },
      { startsAt: new Date(T + 2 * ATOM).toISOString(), beyondHorizon: true },
    ];
    const bookable = windowsForDay(atoms, 1, "UTC", NOW)
      .filter(isBookableWindow)
      .map((w) => w.startsAt);
    expect(bookable).toEqual([new Date(T).toISOString()]);
  });

  it("is not a start the phone day list offers", () => {
    const days = buildDayList(
      {
        "2026-12-06": [
          { startsAt: new Date(T).toISOString(), beyondHorizon: true },
          { startsAt: new Date(T + ATOM).toISOString(), beyondHorizon: true },
        ],
      },
      { zone: "UTC", sessionMinutes: 30, nowMs: NOW },
      T,
    );
    expect(days[0].starts).toEqual([]);
  });
});
