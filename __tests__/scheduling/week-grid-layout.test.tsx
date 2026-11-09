/**
 * The week grid's layout end to end: open hours instead of folded strips
 * (the window runs from the week's earliest to its latest live row with an
 * hour of padding, closed gaps inside stay visible, "Full day" shows every
 * row), and busy runs drawn as one labelled block over cells that keep
 * their names.
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

/** The instant of `hour:minute` on `date` June 2030 in the grid zone. */
function at(date: number, hour: number, minute = 0): number {
  return cellInstant(new Date(2030, 5, date, 12), hour, minute, ZONE).getTime();
}

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

describe("UnifiedCalendar session blocks", () => {
  it("draws a 90-minute booking as one labelled block over three named cells", () => {
    const cells = openDays();
    for (let start = at(12, 10); start < at(12, 11, 30); start += ATOM) {
      cells.set(start, {
        startMs: start,
        endMs: start + ATOM,
        bookingStatus: "fully-booked",
        tooSoon: false,
        limitReached: false,
        overlappingAppointments: [
          { id: "appt-1", type: "Consultation", title: "Spanish B1" },
        ],
      });
    }
    calendarData.serverCells = cells;
    renderGrid();

    const layer = screen.getByTestId("grid-blocks");
    expect(layer).toHaveAttribute("aria-hidden");
    const booked = layer.querySelectorAll("[data-block-state='fullyBooked']");
    expect(booked).toHaveLength(1);
    expect(booked[0].textContent).toMatch(/^Spanish B1 · 10:00 am–11:30 am$/);

    const grid = screen.getByRole("grid");
    const underneath = grid.querySelectorAll("[data-slot-state='fullyBooked']");
    expect(underneath).toHaveLength(3);
    for (const button of Array.from(underneath)) {
      expect(button.getAttribute("aria-label")).toMatch(/^Booked · Wed/);
      // The cells carry no run-label text any more; the block does.
      expect(button.textContent).toBe("");
    }
  });
});

function cellButton(startMs: number): HTMLElement {
  const button = screen
    .getByRole("grid")
    .querySelector<HTMLElement>(
      `[data-slot-start="${new Date(startMs).toISOString()}"]`,
    );
  if (!button) throw new Error("cell not drawn");
  return button;
}

describe("UnifiedCalendar hover ghost", () => {
  it("previews exactly the session a click then asks the selection for", () => {
    renderGrid();
    const tenAm = cellButton(at(12, 10));
    fireEvent.mouseEnter(tenAm);

    const ghost = screen
      .getByTestId("grid-blocks")
      .querySelectorAll("[data-ghost='fits']");
    expect(ghost).toHaveLength(1);
    expect(ghost[0].textContent).toMatch(/^New session · 10:00 am–11:00 am$/);

    fireEvent.click(tenAm);
    const toggleSlot = allocation.toggleSlot as jest.Mock;
    expect(toggleSlot).toHaveBeenCalledTimes(1);
    const [, group] = toggleSlot.mock.calls[0] as [
      unknown,
      { startTime: Date; endTime: Date }[],
    ];
    expect(group[0].startTime.toISOString()).toBe(
      ghost[0].getAttribute("data-ghost-start"),
    );
    expect(group[group.length - 1].endTime.toISOString()).toBe(
      ghost[0].getAttribute("data-ghost-end"),
    );
  });

  it("follows keyboard focus and says when a session cannot fit", () => {
    // 11:30 is the last free half-hour before lunch and 11:00 is taken,
    // so no 1-hour session fits around it.
    const cells = openDays();
    cells.set(at(12, 11), {
      ...(cells.get(at(12, 11)) as ServerCell),
      bookingStatus: "fully-booked",
    });
    calendarData.serverCells = cells;
    renderGrid();
    fireEvent.focus(cellButton(at(12, 11, 30)));
    const ghost = screen
      .getByTestId("grid-blocks")
      .querySelector("[data-ghost]");
    expect(ghost).toHaveAttribute("data-ghost", "blocked");
    expect(ghost?.textContent).toBe("Doesn't fit here");
  });

  it("clears when the pointer leaves the grid", () => {
    renderGrid();
    fireEvent.mouseEnter(cellButton(at(12, 10)));
    fireEvent.mouseLeave(screen.getByRole("grid").parentElement as Element);
    expect(
      screen.getByTestId("grid-blocks").querySelector("[data-ghost]"),
    ).toBeNull();
  });
});

describe("UnifiedCalendar whole-session deselect", () => {
  it("removes only the picked session holding the clicked half-hour", () => {
    const atom = (startMs: number) => ({
      startTime: new Date(startMs),
      endTime: new Date(startMs + ATOM),
      isAvailable: true,
      isBooked: false,
    });
    // Two back-to-back 1-hour picks: 10:00–11:00 and 11:00–12:00.
    allocation.selectedSlots = [0, 1, 2, 3].map((i) =>
      atom(at(12, 10) + i * ATOM),
    );
    renderGrid();
    fireEvent.click(cellButton(at(12, 11, 30)));

    expect(allocation.toggleSlot).not.toHaveBeenCalled();
    const removeSlots = allocation.removeSlots as jest.Mock;
    expect(removeSlots).toHaveBeenCalledTimes(1);
    const removed = (removeSlots.mock.calls[0][0] as { startTime: Date }[]).map(
      (slot) => slot.startTime.getTime(),
    );
    expect(removed).toEqual([at(12, 11), at(12, 11, 30)]);
  });
});
