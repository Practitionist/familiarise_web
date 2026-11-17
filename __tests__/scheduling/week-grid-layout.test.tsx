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
    canAddSlot: () => true,
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

describe("UnifiedCalendar N fit", () => {
  it("prints whole sessions that fit in each week header", () => {
    renderGrid();
    const fits = Array.from(
      screen.getByRole("grid").querySelectorAll("[data-day-fit]"),
    ).map((element) => element.textContent);
    // Sun 9 … Sat 15 Jun; Tue and Wed hold 3 + 4 one-hour sessions.
    expect(fits).toEqual([
      "None fit",
      "None fit",
      "7 fit",
      "7 fit",
      "None fit",
      "None fit",
      "None fit",
    ]);
  });

  it("counts the month by the grid zone's days and starts weeks on the cycle's weekday", () => {
    const cells = openDays();
    // 21:00–23:00 on Thu 13 in New York is already Fri 14 in UTC.
    for (let start = at(13, 21); start < at(13, 23); start += ATOM) {
      cells.set(start, {
        startMs: start,
        endMs: start + ATOM,
        bookingStatus: "available",
        tooSoon: false,
        limitReached: false,
        overlappingAppointments: [],
      });
    }
    calendarData.serverCells = cells;
    render(
      <UnifiedCalendar
        consultantId="consultant-1"
        eventType="subscription"
        eventId="subscription-1"
        mode="allocate"
        sessionDurationInHours={1}
        sessionsPerWeek={2}
        // A Monday cycle start in the grid zone: weeks run Monday to Sunday.
        allowedStart={new Date(at(10, 0))}
        allowedEnd={new Date(at(30, 0))}
        viewerZone={ZONE}
        focus={{ at: FOCUS_AT, precision: "session" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Month" }));

    const fitOn = (key: string) =>
      document.querySelector(`[data-month-day="${key}"]`)?.textContent;
    expect(fitOn("2030-06-12")).toBe("127 fit");
    expect(fitOn("2030-06-13")).toBe("132 fit");
    expect(fitOn("2030-06-14")).toBe("14None fit");

    const firstCell = document.querySelector("[data-month-day]");
    const grid = firstCell?.parentElement as HTMLElement;
    const headers = Array.from(grid.children)
      .slice(0, 7)
      .map((element) => element.textContent);
    expect(headers[0]).toBe("Mon");
    // 1 Jun 2030 is a Saturday: five blanks (Mon–Fri) lead the month.
    expect(Array.from(grid.children).indexOf(firstCell as Element)).toBe(7 + 5);
  });
});

describe("UnifiedCalendar session tray", () => {
  it("numbers each picked session with a remove button and leaves a slot for the next", () => {
    const atom = (startMs: number) => ({
      startTime: new Date(startMs),
      endTime: new Date(startMs + ATOM),
      isAvailable: true,
      isBooked: false,
    });
    allocation.selectedSlots = [0, 1, 2, 3].map((i) =>
      atom(at(12, 13) + i * ATOM),
    );
    allocation.requiredSlots = 6;
    renderGrid();

    const tray = screen.getByTestId("session-tray");
    const picks = within(
      within(tray).getByRole("list", { name: "Picked times" }),
    ).getAllByRole("listitem");
    expect(picks.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Session 1 · Wed,? 12 Jun · 1:00 pm–2:00 pm/),
      expect.stringMatching(/^Session 2 · Wed,? 12 Jun · 2:00 pm–3:00 pm/),
      expect.stringMatching(/^Session 3 · choose a free time on the grid$/),
    ]);

    fireEvent.click(
      within(tray).getByRole("button", { name: /^Remove session 2/ }),
    );
    const removed = (
      (allocation.removeSlots as jest.Mock).mock.calls[0][0] as {
        startTime: Date;
      }[]
    ).map((slot) => slot.startTime.getTime());
    expect(removed).toEqual([at(12, 14), at(12, 14, 30)]);
  });

  it("holds the save actions and the legend slot", () => {
    render(
      <UnifiedCalendar
        consultantId="consultant-1"
        eventType="consultation"
        eventId="consultation-1"
        mode="allocate"
        durationInHours={1}
        viewerZone={ZONE}
        showAllocationButtons
        onClose={() => {}}
        legend={<p>Legend here</p>}
        warnings={["Only 7 of 9 weeks have room."]}
      />,
    );
    const tray = screen.getByTestId("session-tray");
    for (const name of ["Cancel", "Auto-schedule", "Save picked times"]) {
      expect(within(tray).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(tray.textContent).toContain("Legend here");
    expect(tray.textContent).toContain("Only 7 of 9 weeks have room.");
  });
});

describe("UnifiedCalendar context row", () => {
  it("puts the plan, window, earliest start and zone on one row of chips", () => {
    calendarData.leadMs = 2 * 60 * 60 * 1000;
    render(
      <UnifiedCalendar
        consultantId="consultant-1"
        eventType="class"
        eventId="class-1"
        mode="allocate"
        sessionDurationInHours={1}
        sessionsPerWeek={2}
        totalSessions={8}
        allowedStart={new Date(at(10, 0))}
        allowedEnd={new Date(at(30, 0))}
        viewerZone={ZONE}
        showZoneSwitch={false}
        zoneSlot={<span>Zone line</span>}
        contextChips={[{ key: "class-plan", label: "Class", value: "Monthly" }]}
        focus={{ at: FOCUS_AT, precision: "session" }}
      />,
    );
    const row = screen.getByTestId("scheduling-context");
    const text = row.textContent ?? "";
    expect(text).toMatch(/^Class Monthly/);
    expect(text).toContain("Plan 2 a week · 1 hour each");
    expect(text).toMatch(/Scheduling period 10 Jun 2030/);
    expect(text).toContain("Earliest start");
    expect(text).toContain("Zone line");
    // The class daily cap reads from the one cap table, not the weekly count.
    expect(screen.getByTestId("session-tray").textContent).toContain(
      "At most 2 sessions",
    );
  });
});
