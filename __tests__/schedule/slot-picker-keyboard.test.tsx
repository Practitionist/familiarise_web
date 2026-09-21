// #1715 — keyboard cell navigation pin: the allocate grid is an ARIA grid
// with roving tabindex (exactly one tabbable cell), arrow/Home/End moves,
// PageUp/PageDown week paging, and Enter/Space selecting through the SAME
// handleSlotClick path as mouse (auto-expand + guard toasts identical).
//
// Fake-DOM via the same createRoot + act pattern as
// slot-picker-focus-effect.test.tsx: no layout, no VoiceOver, just the
// focus/tabindex/selection contract that a regression would silently break.

jest.mock("@prisma/client", () => ({
  DayOfWeek: {
    SUNDAY: "SUNDAY",
    MONDAY: "MONDAY",
    TUESDAY: "TUESDAY",
    WEDNESDAY: "WEDNESDAY",
    THURSDAY: "THURSDAY",
    FRIDAY: "FRIDAY",
    SATURDAY: "SATURDAY",
  },
  Prisma: {},
}));

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("../../hooks/scheduling/useCalendarData", () => ({
  useCalendarData: () => calendarData,
}));

jest.mock("../../hooks/scheduling/useScheduling", () => ({
  useEventSlotAllocation: () => allocation,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { UnifiedCalendar } from "../../components/scheduling/UnifiedCalendar";

function slotStatus(interval: { hour: number; minute: number }, date: Date) {
  const start = new Date(date);
  start.setHours(interval.hour, interval.minute, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    isAvailable: true,
    isBooked: false,
    isBookedForDisplay: false,
    isPartiallyBooked: false,
    isDisabled: false,
    isInPast: false,
    intervalStartUTCString: start.toISOString(),
    intervalEndUTCString: end.toISOString(),
    localStartTime: start,
    localEndTime: end,
    overlappingAppointments: [],
  };
}

let calendarData: Record<string, unknown>;
let allocation: Record<string, unknown> & { toggleSlot: jest.Mock };

const NO_AVAILABILITY: { startTime: Date }[] = [];

function setCalendarData(overrides: Record<string, unknown> = {}) {
  calendarData = {
    consultantDetails: { id: "consultant-1" },
    availableSlots: NO_AVAILABILITY,
    eventSlots: [],
    eventTentativeSlots: [],
    weeklyConfirmedCallCounts: {},
    eventOccurrences: [],
    subscriptionMeta: null,
    loading: false,
    error: null,
    refetch: jest.fn(),
    refetchEventSlots: jest.fn(),
    refetchAvailability: jest.fn(),
    getSlotStatusForInterval: slotStatus,
    ...overrides,
  };
}

function resetAllocation() {
  allocation = {
    selectedSlots: [],
    setSelectedSlots: jest.fn(),
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: jest.fn(),
    clearSlots: jest.fn(),
    isSlotSelected: () => false,
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    allocateRequestedSlots: jest.fn(),
    slotLimits: { slotsPerSession: 2, maxSlots: 10, totalSessions: 5 },
  };
}

function cells(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll("[data-slot-start]")).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
}

function tabbable(host: HTMLElement): HTMLElement[] {
  return cells(host).filter((el) => el.tabIndex === 0);
}

function keyOf(el: Element | null): string | null {
  return el instanceof HTMLElement ? el.getAttribute("data-slot-start") : null;
}

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("UnifiedCalendar keyboard grid (#1715)", () => {
  let host: HTMLElement;
  let root: Root;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  beforeEach(() => {
    setCalendarData();
    resetAllocation();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <UnifiedCalendar
          consultantId="consultant-1"
          eventType="consultation"
          eventId="event-1"
          mode="allocate"
          durationInHours={1}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders an ARIA grid with row/gridcell semantics and labels", () => {
    const grid = host.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-label")).toContain("arrow keys");
    expect(host.querySelectorAll('[role="row"]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('[role="gridcell"]').length).toBe(
      cells(host).length,
    );
    // State rides on every cell's accessible name.
    const first = cells(host)[0];
    expect(first.getAttribute("aria-label")).toContain("Available");
  });

  it("keeps exactly one cell tabbable (roving tabindex)", () => {
    expect(cells(host).length).toBeGreaterThan(0);
    expect(tabbable(host)).toHaveLength(1);
  });

  it("moves with arrows, jumps with Home/End, selects with Enter", () => {
    const all = cells(host);
    const perRow = 7;

    // Tab lands on the single roving stop; focus it.
    const first = tabbable(host)[0];
    act(() => first.focus());
    expect(keyOf(document.activeElement)).toBe(keyOf(first));

    // Right: same row, next day.
    press(document.activeElement!, "ArrowRight");
    expect(keyOf(document.activeElement)).toBe(keyOf(all[1]));
    expect(tabbable(host)).toHaveLength(1);
    expect(keyOf(tabbable(host)[0])).toBe(keyOf(all[1]));

    // Down: next interval, same day.
    press(document.activeElement!, "ArrowDown");
    expect(keyOf(document.activeElement)).toBe(keyOf(all[1 + perRow]));
    expect(tabbable(host)).toHaveLength(1);

    // Home: first interval of the day. End: last interval of the day.
    press(document.activeElement!, "Home");
    expect(keyOf(document.activeElement)).toBe(keyOf(all[1]));
    press(document.activeElement!, "End");
    // Last interval of the same day column.
    expect(keyOf(document.activeElement)).toBe(
      keyOf(all[all.length - perRow + 1]),
    );
    expect(tabbable(host)).toHaveLength(1);

    // Enter selects through the click path (auto-expand group of 2).
    press(document.activeElement!, "Enter");
    expect(allocation.toggleSlot).toHaveBeenCalledTimes(1);
    expect(allocation.toggleSlot.mock.calls[0][1]).toHaveLength(2);
  });

  it("pages the week with PageDown and lands on the new week's first cell", () => {
    const beforeFirst = keyOf(tabbable(host)[0]);
    act(() => tabbable(host)[0].focus());
    press(document.activeElement!, "PageDown");

    // New week rendered, focus moved to its first cell, still one tab stop.
    expect(tabbable(host)).toHaveLength(1);
    const after = document.activeElement;
    expect(after instanceof HTMLElement).toBe(true);
    expect(keyOf(after)).not.toBeNull();
    expect(keyOf(after)).toBe(keyOf(tabbable(host)[0]));
    expect(keyOf(after)).not.toBe(beforeFirst);
  });
});
