// #1073 — the focus effect itself, which is where all the risk in this change
// lives: it has to fire exactly once, and it has to fire at all.
//
// The week grid does not exist until `consultantDetails` has arrived, and
// `useCalendarData` fetches details and availability independently. Keying the
// effect on anything that settles BEFORE the grid mounts means it runs against
// a null container, returns, and — a ref being unable to wake an effect —
// never runs again. That failure is silent and race-dependent, which is why it
// is pinned here rather than left to manual testing.

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("../../hooks/scheduling/useCalendarData", () => ({
  useCalendarData: () => calendarData,
}));

jest.mock("../../hooks/scheduling/useScheduling", () => ({
  earliestSelectedSlot: () => null,
  useEventSlotAllocation: () => allocation,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  UnifiedCalendar,
  weekStartFor,
} from "../../components/scheduling/UnifiedCalendar";
import {
  FOCUS_LEAD_ROWS,
  gridTimeZone,
  type TimePickerFocus,
} from "../../lib/scheduling/time-picker-focus";
import type { ServerCell } from "../../lib/scheduling/week-grid-model";
import { startOfWeek } from "date-fns";
import { dayStartInstant } from "../../lib/time/grid-zone";

/** Every row is one of these tall; jsdom has no layout, so we supply it. */
const ROW_HEIGHT = 32;
/** 10:30 on the target day → hour 10, half-hour 1. */
const TARGET_ROW = 21;
/** FOCUS_LEAD_ROWS of headroom, so the target is in view and not clipped. */
const EXPECTED_SCROLL_ROW = TARGET_ROW - FOCUS_LEAD_ROWS;

const SCROLL_CONTAINER_CLASS = "overflow-y-auto";

const ATOM = 30 * 60 * 1000;

/** Every half-hour of the (future) target week published, in the device zone. */
function publishedWeek(): Map<number, ServerCell> {
  const map = new Map<number, ServerCell>();
  const first = startOfWeek(new Date(2030, 7, 1, 12));
  const start = dayStartInstant(
    new Date(first.getFullYear(), first.getMonth(), first.getDate(), 12),
    gridTimeZone(),
  ).getTime();
  for (let at = start; at < start + 7 * 24 * 60 * 60 * 1000; at += ATOM) {
    map.set(at, {
      startMs: at,
      endMs: at + ATOM,
      bookingStatus: "available",
      tooSoon: false,
      limitReached: false,
      overlappingAppointments: [],
    });
  }
  return map;
}
const PUBLISHED_WEEK = publishedWeek();
const NOTHING_PUBLISHED = new Map<number, ServerCell>();

let calendarData: Record<string, unknown>;
let allocation: Record<string, unknown>;

// ONE array, reused across renders. A fresh `[]` each time would change the
// identity of a value the pre-fix effect listed in its deps, which is enough
// to wake it by accident and hide the very bug these tests exist to catch.
const NO_AVAILABILITY: { startTime: Date }[] = [];

function setCalendarData(overrides: Record<string, unknown> = {}) {
  calendarData = {
    consultantDetails: { id: "consultant-1" },
    availableSlots: NO_AVAILABILITY,
    serverCells: PUBLISHED_WEEK,
    // A settled read whose window covers whatever week is shown.
    cellsWindow: { startMs: 0, endMs: Number.MAX_SAFE_INTEGER },
    eventSlots: [],
    eventTentativeSlots: [],
    weeklyConfirmedCallCounts: {},
    eventOccurrences: [],
    subscriptionMeta: null,
    quota: null,
    loading: false,
    refreshing: false,
    error: null,
    eventSlotsFailed: false,
    // #1863 — a REQUIRED field of UseCalendarDataReturn, not an optional one, so
    // a mock that omits it does not render a quieter grid: the footer reads
    // `freshness.label` unguarded and every render in this file threw on it.
    // The hook's own initial value — never fetched yet, so nothing to say.
    availabilityFreshness: {
      freshness: "unknown",
      label: null,
      failed: false,
    },
    refetch: jest.fn(),
    refetchEventSlots: jest.fn(),
    refetchAvailability: jest.fn(),
    ...overrides,
  };
}

function resetAllocation() {
  allocation = {
    selectedSlots: [],
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: jest.fn(),
    clearSlots: jest.fn(),
    removeSlots: jest.fn(),
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    partialOffer: null,
    dismissPartialOffer: jest.fn(),
    slotLimits: { slotsPerSession: 2, maxSlots: 10, totalSessions: 5 },
    canAddSlot: () => true,
  };
}

/**
 * jsdom reports every rect as zero, so the measured scroll would always be a
 * no-op. Give the scroll container's own children a height, keyed off their
 * position, and leave everything else at the origin.
 */
function stubLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.getAttribute("data-row");
    const top = row === null ? 0 : Number(row) * ROW_HEIGHT;
    return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
  };
}

function weekGrid(host: HTMLElement): HTMLElement {
  const grid = host.querySelector(`.${SCROLL_CONTAINER_CLASS}`);
  if (!(grid instanceof HTMLElement)) throw new Error("week grid not rendered");
  return grid;
}

// Local noon so the row is read in the same zone the grid draws in, whatever
// zone the test happens to run in.
const target = new Date(2030, 7, 1, 10, 30, 0, 0);
const focus: TimePickerFocus = { at: target, precision: "session" };

describe("UnifiedCalendar focus effect", () => {
  let host: HTMLElement;
  let root: Root;
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
    stubLayout();
  });

  afterAll(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    setCalendarData();
    resetAllocation();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        <UnifiedCalendar
          consultantId="consultant-1"
          eventType="consultation"
          eventId="event-1"
          mode="allocate"
          durationInHours={1}
          focus={focus}
          {...props}
        />,
      );
    });
  }

  it("scrolls the target into view with rows to spare above it", () => {
    render();

    expect(weekGrid(host).scrollTop).toBe(EXPECTED_SCROLL_ROW * ROW_HEIGHT);
  });

  it("fires once the grid appears, even when it appears late", () => {
    // The race: availability settles first, so the effect's other inputs are
    // already final while the grid is still unrendered.
    setCalendarData({ consultantDetails: null });
    render();
    expect(host.querySelector(`.${SCROLL_CONTAINER_CLASS}`)).toBeNull();

    // Details arrive. NOTHING else changes — not availability, not `loading`,
    // not the view. Only the grid's existence is new.
    setCalendarData();
    render();

    expect(weekGrid(host).scrollTop).toBe(EXPECTED_SCROLL_ROW * ROW_HEIGHT);
  });

  it("never re-aims the grid once the consultant has scrolled away", () => {
    render();
    const grid = weekGrid(host);
    grid.scrollTop = 900;

    // A refetch: new availability, new array identity, same focus.
    setCalendarData({ availableSlots: [{ startTime: target }] });
    render();

    expect(weekGrid(host).scrollTop).toBe(900);
  });

  it("does nothing at all without a focus target", () => {
    render({ focus: undefined });

    expect(weekGrid(host).scrollTop).toBe(0);
  });

  it("anchors a period target on first published availability, not midnight", () => {
    // Midnight on the target day carries no time of day; 09:00 is where the
    // consultant's grid actually has something in it.
    const start = new Date(2030, 7, 1, 0, 0, 0, 0);
    setCalendarData({
      availableSlots: [{ startTime: new Date(2030, 7, 3, 9, 0, 0, 0) }],
    });
    render({ focus: { at: start, precision: "period" } });

    // Row 18 is 09:00; two rows of headroom leaves 16.
    expect(weekGrid(host).scrollTop).toBe(16 * ROW_HEIGHT);
  });
});

// #1764/#1766 — the allocate page's three consultant-facing fixes: a
// skeleton before the empty state, one band instead of scattered
// "Outside period" cells, and a cycle-honest subscription heading.
describe("UnifiedCalendar allocate-page states (#1764, #1766)", () => {
  let host: HTMLElement;
  let root: Root;
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
    stubLayout();
  });

  afterAll(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    setCalendarData();
    resetAllocation();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        <UnifiedCalendar
          consultantId="consultant-1"
          eventType="consultation"
          eventId="event-1"
          mode="allocate"
          durationInHours={1}
          {...props}
        />,
      );
    });
  }

  it("shows the grid skeleton, not the empty-week notice, while the fetch is pending", () => {
    setCalendarData({ loading: true, consultantDetails: null });
    render();

    expect(host.textContent).not.toContain("Nothing is published");
    // The skeleton renders shadcn's Skeleton primitive; the real grid's own
    // scroll container (asserted absent) is what "no skeleton" would leave.
    expect(host.querySelector(`.${SCROLL_CONTAINER_CLASS}`)).toBeNull();
  });

  it("shows the empty-week notice only once the fetch has settled with nothing published", () => {
    // Nothing published anywhere this week — the settled, truly-empty case
    // the notice exists for, distinct from the outside-period case below.
    setCalendarData({ loading: false, serverCells: NOTHING_PUBLISHED });
    render({ focus });

    expect(host.textContent).toContain("Nothing is published this week");
  });

  it("shows an entirely out-of-period week as the full day with a note, never band strips or per-cell words", () => {
    // Every half-hour this week is published, but the request's period
    // starts after the whole visible week, so every cell is outside it.
    render({
      focus,
      allowedStart: new Date(2030, 7, 20),
      allowedEnd: new Date(2030, 8, 20),
    });

    expect(host.textContent).toContain(
      "Nothing this week falls inside this booking's dates",
    );
    expect(host.querySelectorAll("[role='row'][data-row]")).toHaveLength(48);
    expect(host.textContent).not.toMatch(/Unavailable ·|· show|· hide/);

    const exactMatches = Array.from(
      host.querySelectorAll("button, div"),
    ).filter((el) => el.textContent?.trim() === "Outside period");
    expect(exactMatches).toHaveLength(0);
  });

  it("leads a fresh subscription with what fits this cycle, not the plan's lifetime total", () => {
    // #1766 — the heading reads the row's frozen entitlement through the one
    // helper: a 3-a-week plan's first cycle takes 3, whatever the total is.
    setCalendarData({
      eventSlots: [],
      eventOccurrences: [],
      subscriptionMeta: {
        sessionsTotal: 144,
        sessionsRefunded: 0,
        sessionsPerWeek: 3,
        durationInMonths: 12,
        schedulingPeriodStartsAt: new Date(2026, 0, 1).toISOString(),
        schedulingTimezone: "Asia/Kolkata",
      },
    });
    render({
      eventType: "subscription",
      sessionDurationInHours: 1,
      sessionsPerWeek: 3,
      totalSessions: 144,
      allowedStart: new Date(2026, 0, 1),
      allowedEnd: new Date(2026, 0, 13, 23, 59, 59, 999),
    });

    expect(host.textContent).toMatch(/Week \d+ of \d+ · pick 3 for/);
    expect(host.textContent).toContain("0 of 144 booked");
  });

  it.each([
    // A one-month plan that ended in February: nothing more to pick.
    ["ended", new Date(2026, 1, 1).toISOString(), "Plan ended on"],
    // The same plan extended by an incident far into the future opens again.
    ["extended", new Date(2031, 0, 1).toISOString(), "pick 3 for"],
  ])("reads the stored plan end (%s)", (_label, planEndsAt, expected) => {
    setCalendarData({
      eventSlots: [],
      eventOccurrences: [],
      subscriptionMeta: {
        sessionsTotal: 12,
        sessionsRefunded: 0,
        sessionsPerWeek: 3,
        durationInMonths: 1,
        schedulingPeriodStartsAt: new Date(2026, 0, 1).toISOString(),
        schedulingTimezone: "Asia/Kolkata",
        planEndsAt,
      },
    });
    render({
      eventType: "subscription",
      sessionDurationInHours: 1,
      sessionsPerWeek: 3,
      totalSessions: 12,
    });
    expect(host.textContent).toContain(expected);
  });
});

// #1775 PR-B — a subscription's week grid starts on its cycle's start day;
// everything else keeps the Sunday the quota bucketing is pinned to.
describe("weekStartFor (#1775)", () => {
  it("subscription with a Wednesday cycle start → 3; consultation → 0", () => {
    const wednesday = new Date(2026, 8, 23, 9, 0, 0); // 2026-09-23 is a Wednesday
    expect(
      weekStartFor({
        eventType: "subscription",
        cycleStart: wednesday,
        zone: gridTimeZone(),
      }),
    ).toBe(3);
    expect(
      weekStartFor({
        eventType: "consultation",
        cycleStart: wednesday,
        zone: gridTimeZone(),
      }),
    ).toBe(0);
    expect(
      weekStartFor({
        eventType: "subscription",
        cycleStart: null,
        zone: "UTC",
      }),
    ).toBe(0);
  });
});

describe("weekStartFor reads the cycle's start day in the grid zone", () => {
  it("a Monday-midnight IST cycle starts on Monday whatever the device zone", () => {
    // 00:00 Mon 21 Sep 2026 in Kolkata is still Sunday 20 Sep in UTC.
    const cycleStart = new Date("2026-09-20T18:30:00.000Z");
    expect(
      weekStartFor({
        eventType: "subscription",
        cycleStart,
        zone: "Asia/Kolkata",
      }),
    ).toBe(1);
    expect(
      weekStartFor({ eventType: "subscription", cycleStart, zone: "UTC" }),
    ).toBe(0);
  });
});
