/**
 * #1168 & #1715 — Allocate grid timezone resolution, ARIA grid semantics,
 * roving tabindex keyboard navigation, and SlotStatusLegend ARIA labels.
 */

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

import { resolveGridZone } from "@/lib/scheduling/intervalSelectionValidation";
import { SlotStatusLegend } from "@/components/scheduling/SlotStatusLegend";
import { UnifiedCalendar } from "@/components/scheduling/UnifiedCalendar";

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
let allocation: Record<string, unknown>;
const toggleSlotMock = jest.fn();

function resetMocks() {
  toggleSlotMock.mockReset();
  calendarData = {
    consultantDetails: { id: "consultant-1" },
    availableSlots: [],
    eventSlots: [],
    eventTentativeSlots: [],
    weeklyConfirmedCallCounts: {},
    eventOccurrences: [],
    subscriptionMeta: null,
    loading: false,
    error: null,
    availabilityFreshness: {
      freshness: "unknown",
      label: null,
      failed: false,
    },
    refetch: jest.fn(),
    refetchEventSlots: jest.fn(),
    refetchAvailability: jest.fn(),
    getSlotStatusForInterval: slotStatus,
  };
  allocation = {
    selectedSlots: [],
    setSelectedSlots: jest.fn(),
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: toggleSlotMock,
    clearSlots: jest.fn(),
    isSlotSelected: () => false,
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    allocateRequestedSlots: jest.fn(),
    slotLimits: { slotsPerSession: 2, maxSlots: 10, totalSessions: 5 },
  };
}

describe("resolveGridZone (#1168)", () => {
  it("defaults to schedulingTimezone for subscription and class events", () => {
    expect(
      resolveGridZone("America/New_York", "UTC", {
        eventType: "subscription",
        schedulingTimezone: "Asia/Kolkata",
      }),
    ).toBe("Asia/Kolkata");

    expect(
      resolveGridZone("America/New_York", "UTC", {
        eventType: "class",
        schedulingTimezone: "Asia/Kolkata",
      }),
    ).toBe("Asia/Kolkata");
  });

  it("defaults to viewerZone for consultation and webinar events", () => {
    expect(
      resolveGridZone("America/New_York", "UTC", {
        eventType: "consultation",
        schedulingTimezone: "Asia/Kolkata",
      }),
    ).toBe("America/New_York");

    expect(
      resolveGridZone("America/New_York", "UTC", {
        eventType: "webinar",
        schedulingTimezone: "Asia/Kolkata",
      }),
    ).toBe("America/New_York");
  });

  it("returns viewerZone when preferViewerZone: true is set on a subscription", () => {
    expect(
      resolveGridZone("America/New_York", "UTC", {
        eventType: "subscription",
        schedulingTimezone: "Asia/Kolkata",
        preferViewerZone: true,
      }),
    ).toBe("America/New_York");
  });

  it("falls back to browserZone when viewerZone is invalid", () => {
    expect(resolveGridZone("Invalid/Zone", "Asia/Kolkata")).toBe(
      "Asia/Kolkata",
    );
  });
});

describe("SlotStatusLegend ARIA & UnifiedCalendar keyboard navigation (#1715)", () => {
  let host: HTMLElement;
  let root: Root;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    resetMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders role='img' and aria-label on each SlotStatusLegend item with aria-hidden swatch", () => {
    act(() => {
      root.render(
        React.createElement(SlotStatusLegend, {
          keys: [
            "available",
            "selected",
            "rescheduling",
            "fullyBooked",
            "past",
          ],
        }),
      );
    });

    const items = host.querySelectorAll('li[role="img"]');
    expect(items).toHaveLength(5);
    const labels = Array.from(items).map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Available: Free to book.",
      "Selected: You have chosen this time.",
      "Being moved: Released by a reschedule and awaiting a new time.",
      "Booked: Already taken.",
      "Past: Already gone; shown so the day reads whole.",
    ]);
    // Inner swatch spans are aria-hidden="true" and do not carry a nested role="img"
    expect(host.querySelectorAll('span[role="img"]')).toHaveLength(0);
    const swatches = host.querySelectorAll('li[role="img"] > span:first-child');
    expect(swatches).toHaveLength(5);
    swatches.forEach((swatch) => {
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("wires ARIA grid roles, roving tabindex, arrow navigation, Enter/Space selection, and live status", () => {
    act(() => {
      root.render(
        React.createElement(UnifiedCalendar, {
          consultantId: "consultant-1",
          eventType: "subscription",
          eventId: "sub-1",
          mode: "allocate",
          durationInHours: 1,
          viewerZone: "America/New_York",
          schedulingTimezone: "Asia/Kolkata",
        }),
      );
    });

    const grid = host.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-label")).toBe("Availability slot grid");

    const rows = host.querySelectorAll('[role="row"]');
    expect(rows).toHaveLength(48);

    const gridcells = host.querySelectorAll('[role="gridcell"]');
    expect(gridcells).toHaveLength(48 * 7);
    expect(gridcells[0]?.getAttribute("aria-selected")).toBe("false");

    // Live status region announces selected slot count
    const statusRegion = host.querySelector('[role="status"][aria-live="polite"]');
    expect(statusRegion?.textContent).toContain("Selected 0 of 2 slots");

    // Timezone toggle renders when schedulingTimezone !== viewerZone on subscription
    const tzToggle = host.querySelector('[data-testid="grid-zone-toggle"]') as HTMLButtonElement | null;
    expect(tzToggle).not.toBeNull();
    expect(tzToggle?.textContent).toContain("Expert zone (Asia/Kolkata)");

    act(() => {
      tzToggle?.click();
    });
    expect(tzToggle?.textContent).toContain("Your zone (America/New_York)");

    // Roving tabindex starts at (0, 0)
    const cell00 = host.querySelector(
      'button[data-day-index="0"][data-slot-index="0"]',
    ) as HTMLButtonElement | null;
    const cell10 = host.querySelector(
      'button[data-day-index="1"][data-slot-index="0"]',
    ) as HTMLButtonElement | null;
    const cell11 = host.querySelector(
      'button[data-day-index="1"][data-slot-index="1"]',
    ) as HTMLButtonElement | null;

    expect(cell00?.tagName).toBe("BUTTON");
    expect(cell00?.getAttribute("aria-disabled")).toBe("false");
    expect(cell00?.getAttribute("tabindex")).toBe("0");
    expect(cell00?.getAttribute("aria-pressed")).toBe("false");
    expect(cell00?.getAttribute("aria-selected")).toBeNull();
    expect(cell10?.getAttribute("tabindex")).toBe("-1");

    // ArrowRight moves focus to dayIndex=1, slotIndex=0
    act(() => {
      cell00?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(cell10?.getAttribute("tabindex")).toBe("0");
    expect(cell00?.getAttribute("tabindex")).toBe("-1");

    // ArrowDown moves focus to dayIndex=1, slotIndex=1
    act(() => {
      cell10?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(cell11?.getAttribute("tabindex")).toBe("0");

    // Enter toggles the focused slot
    act(() => {
      cell11?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(toggleSlotMock).toHaveBeenCalledTimes(1);
  });

  it("renders fast-exit unavailable cells as native buttons with aria-disabled='true'", () => {
    calendarData.getSlotStatusForInterval = (
      interval: { hour: number; minute: number },
      date: Date,
    ) => ({
      ...slotStatus(interval, date),
      isAvailable: false,
    });

    act(() => {
      root.render(
        React.createElement(UnifiedCalendar, {
          consultantId: "consultant-1",
          eventType: "subscription",
          eventId: "sub-1",
          mode: "allocate",
          durationInHours: 1,
        }),
      );
    });

    const cell00 = host.querySelector(
      'button[data-day-index="0"][data-slot-index="0"]',
    ) as HTMLButtonElement | null;
    expect(cell00).not.toBeNull();
    expect(cell00?.tagName).toBe("BUTTON");
    expect(cell00?.getAttribute("aria-disabled")).toBe("true");
    expect(cell00?.getAttribute("tabindex")).toBe("0");
  });
});
