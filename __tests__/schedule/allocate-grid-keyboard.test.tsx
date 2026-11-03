/**
 * The allocate grid end to end: legend ARIA, valid grid roles, the zone
 * switch, plain-words live status, and activation reaching the selection.
 */

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

import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { SlotStatusLegend } from "@/components/scheduling/SlotStatusLegend";
import { UnifiedCalendar } from "@/components/scheduling/UnifiedCalendar";
import type { ServerCell } from "@/lib/scheduling/week-grid-model";
import { dayStartInstant } from "@/lib/time/grid-zone";

const ATOM = 30 * 60 * 1000;
const ZONE = "America/New_York";
/** A June week far ahead: no clock change, nothing in the past. */
const FOCUS_AT = new Date(Date.UTC(2030, 5, 12, 14, 0));

function weekCells(): Map<number, ServerCell> {
  const map = new Map<number, ServerCell>();
  const start = dayStartInstant(new Date(2030, 5, 9, 12), ZONE).getTime();
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

let calendarData: Record<string, unknown>;
let allocation: Record<string, unknown>;
const toggleSlotMock = jest.fn();

beforeEach(() => {
  toggleSlotMock.mockReset();
  calendarData = {
    consultantDetails: { id: "consultant-1", name: "Ada" },
    serverCells: weekCells(),
    cellsWindow: null,
    availableSlots: [],
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
    availabilityFreshness: { freshness: "unknown", label: null, failed: false },
    refetch: jest.fn(),
    refetchEventSlots: jest.fn(),
    refetchAvailability: jest.fn(),
  };
  allocation = {
    selectedSlots: [],
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: toggleSlotMock,
    clearSlots: jest.fn(),
    removeSlots: jest.fn(),
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    partialOffer: null,
    dismissPartialOffer: jest.fn(),
    slotLimits: { slotsPerSession: 2, maxSlots: 10, totalSessions: 5 },
  };
});

describe("SlotStatusLegend ARIA", () => {
  it("labels each key in plain words and hides the swatch", () => {
    render(
      <SlotStatusLegend
        keys={[
          "available",
          "selected",
          "rescheduling",
          "fullyBooked",
          "limitReached",
        ]}
      />,
    );
    // Each key stays a list item; its words ride a screen-reader-only span.
    expect(screen.queryAllByRole("img")).toEqual([]);
    const items = screen.getAllByRole("listitem");
    expect(
      items.map((item) => item.querySelector(".sr-only")?.textContent),
    ).toEqual([
      "Free: Free to book.",
      "Selected: You have chosen this time.",
      "Being moved: Released by a reschedule and waiting for a new time.",
      "Booked: Already taken.",
      "Limit reached: This plan's sessions for that week or day are already used.",
    ]);
    for (const item of items) {
      expect(item.querySelector("[data-legend-swatch]")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
  });
});

describe("UnifiedCalendar allocate grid", () => {
  function renderGrid() {
    return render(
      <UnifiedCalendar
        consultantId="consultant-1"
        eventType="consultation"
        eventId="consultation-1"
        mode="allocate"
        durationInHours={1}
        viewerZone={ZONE}
        focus={{ at: FOCUS_AT, precision: "session" }}
      />,
    );
  }

  it("renders a valid grid with a header row and one row per half-hour", () => {
    renderGrid();
    const grid = screen.getByRole("grid", {
      name: "Available half-hour times",
    });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(49);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(48 * 7);
    expect(within(rows[0]).getAllByRole("columnheader")).toHaveLength(8);
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(48);
  });

  it("announces progress in times, never slots", () => {
    renderGrid();
    const status = screen
      .getAllByRole("status")
      .find((element) => element.getAttribute("aria-live") === "polite");
    expect(status?.textContent).toBe("0 of 1 time picked");
    expect(document.body.textContent ?? "").not.toMatch(/\bslots?\b/i);
  });

  it("shows the zone and lets the viewer switch to the device zone", () => {
    // No test machine runs in Chatham, so the device zone always differs.
    render(
      <UnifiedCalendar
        consultantId="consultant-1"
        eventType="consultation"
        mode="allocate"
        durationInHours={1}
        viewerZone="Pacific/Chatham"
      />,
    );
    const zoneLine = screen.getByTestId("zone-switch");
    expect(zoneLine.textContent).toMatch(/Times shown in/);
    const toggle = within(zoneLine).getByRole("button");
    expect(toggle).toHaveTextContent("Use my device's time zone");
    fireEvent.click(toggle);
    expect(
      within(screen.getByTestId("zone-switch")).getByRole("button"),
    ).toHaveTextContent("Use my profile time zone");
  });

  it("activating a free cell asks the selection for a whole session", () => {
    renderGrid();
    const grid = screen.getByRole("grid");
    const nineAm = within(grid)
      .getAllByRole("button")
      .find(
        (button) =>
          button.getAttribute("data-slot-start") === "2030-06-12T13:00:00.000Z",
      );
    expect(nineAm).toBeDefined();
    fireEvent.click(nineAm as HTMLElement);
    expect(toggleSlotMock).toHaveBeenCalledTimes(1);
    const [, group] = toggleSlotMock.mock.calls[0];
    expect(group).toHaveLength(2);
  });
});
