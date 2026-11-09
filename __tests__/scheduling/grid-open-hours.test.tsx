/**
 * The week grid shows open hours, not folded strips: the window runs from the
 * week's earliest to its latest live row with an hour of padding, closed gaps
 * inside it stay visible, and "Full day" shows every row.
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

import { UnifiedCalendar } from "@/components/scheduling/UnifiedCalendar";
import {
  OPEN_HOURS_PAD_ROWS,
  openHoursWindow,
  type ServerCell,
} from "@/lib/scheduling/week-grid-model";
import { cellInstant } from "@/lib/time/grid-zone";

const ATOM = 30 * 60 * 1000;
const ZONE = "America/New_York";
/** Wed 12 Jun 2030: a June week far ahead, no clock change, nothing past. */
const FOCUS_AT = new Date(Date.UTC(2030, 5, 12, 14, 0));

/** 09:00–12:00 and 13:00–17:00 on Tue 11 and Wed 12 Jun: lunch stays closed. */
function openDays(): Map<number, ServerCell> {
  const map = new Map<number, ServerCell>();
  for (const date of [11, 12]) {
    for (const [fromHour, toHour] of [
      [9, 12],
      [13, 17],
    ]) {
      const start = cellInstant(
        new Date(2030, 5, date, 12),
        fromHour,
        0,
        ZONE,
      ).getTime();
      for (let at = start; at < start + (toHour - fromHour) * 2 * ATOM;) {
        map.set(at, {
          startMs: at,
          endMs: at + ATOM,
          bookingStatus: "available",
          tooSoon: false,
          limitReached: false,
          overlappingAppointments: [],
        });
        at += ATOM;
      }
    }
  }
  return map;
}

let calendarData: Record<string, unknown>;
let allocation: Record<string, unknown>;

beforeEach(() => {
  calendarData = {
    consultantDetails: { id: "consultant-1", name: "Ada" },
    serverCells: openDays(),
    cellsWindow: null,
    availableSlots: [],
    eventSlots: [],
    eventTentativeSlots: [],
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
  };
});

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

function rowHeaders(): string[] {
  const grid = screen.getByRole("grid");
  return within(grid)
    .getAllByRole("rowheader")
    .map((header) => header.textContent ?? "");
}

describe("openHoursWindow", () => {
  it("pads the earliest and latest live rows by an hour and clamps to the day", () => {
    const live = Array.from({ length: 48 }, (_, i) => i >= 18 && i < 34);
    expect(openHoursWindow(live)).toEqual({
      from: 18 - OPEN_HOURS_PAD_ROWS,
      to: 34 + OPEN_HOURS_PAD_ROWS,
    });
    const edges = Array.from({ length: 48 }, (_, i) => i === 0 || i === 47);
    expect(openHoursWindow(edges)).toEqual({ from: 0, to: 48 });
  });

  it("is null for a week with nothing live", () => {
    expect(openHoursWindow(Array.from({ length: 48 }, () => false))).toBe(null);
  });
});

describe("UnifiedCalendar open-hours window", () => {
  it("draws 08:00 to 18:00 by default, with lunch still visible as closed cells", () => {
    renderGrid();
    const headers = rowHeaders();
    // 09:00–17:00 live, padded an hour each side: 08:00 … 17:30, 20 rows.
    expect(headers).toHaveLength(20);
    expect(headers[0]).toMatch(/^8:00/);
    expect(headers[headers.length - 1]).toMatch(/^5:30/);
    const lunch = screen
      .getByRole("grid")
      .querySelector(`[data-slot-start="2030-06-12T16:00:00.000Z"]`);
    expect(lunch).toHaveAttribute("data-slot-state", "unavailable");
  });

  it("renders no folded band strips", () => {
    renderGrid();
    expect(document.body.textContent ?? "").not.toMatch(/Unavailable ·/);
    expect(
      within(screen.getByRole("grid")).queryAllByRole("button", {
        expanded: false,
      }),
    ).toEqual([]);
  });

  it("shows every row under Full day", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Full day" }));
    expect(rowHeaders()).toHaveLength(48);
    fireEvent.click(screen.getByRole("button", { name: "Open hours" }));
    expect(rowHeaders()).toHaveLength(20);
  });
});
