/**
 * On a reschedule, a session of the same booking that is not being moved is
 * not a time to pick: the server keeps it, so picking it could only be
 * refused. The sessions being moved stay pickable.
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react";

import type { CalendarInterval } from "@/lib/scheduling/calendarUtils";
import {
  selectionConflicts,
  stayingSessionStarts,
  type AtomContext,
  type ServerCell,
} from "@/lib/scheduling/week-grid-model";

const ATOM = 30 * 60 * 1000;
const HOUR = 2 * ATOM;
// Wed 18 Nov 2026, 10:00 in Asia/Kolkata.
const NOW = Date.UTC(2026, 10, 18, 4, 30);
// Tue 24 Nov and Thu 26 Nov, 10:00–11:00 in Asia/Kolkata.
const MOVING = Date.UTC(2026, 10, 24, 4, 30);
const STAYING = Date.UTC(2026, 10, 26, 4, 30);

const mockToast = jest.fn();
const mockToggleSlot = jest.fn();
let mockCalendarData: Record<string, unknown> = {};

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("@/hooks/scheduling/useCalendarData", () => ({
  useCalendarData: () => mockCalendarData,
}));

jest.mock("@/hooks/scheduling/useScheduling", () => ({
  earliestSelectedSlot: (slots: CalendarInterval[]) => slots[0] ?? null,
  useEventSlotAllocation: () => ({
    selectedSlots: [],
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: mockToggleSlot,
    clearSlots: jest.fn(),
    removeSlots: jest.fn(),
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    partialOffer: null,
    dismissPartialOffer: jest.fn(),
    canAddSlot: () => true,
    slotLimits: { slotsPerSession: 2, maxSlots: 2, totalSessions: 1 },
  }),
}));

import { UnifiedCalendar } from "@/components/scheduling/UnifiedCalendar";

function cell(
  startMs: number,
  bookingStatus: ServerCell["bookingStatus"],
): ServerCell {
  return {
    startMs,
    endMs: startMs + ATOM,
    bookingStatus,
    tooSoon: false,
    limitReached: false,
    overlappingAppointments: [],
  };
}

const atom = (startMs: number): CalendarInterval => ({
  startTime: new Date(startMs),
  endTime: new Date(startMs + ATOM),
  isAvailable: true,
  isBooked: true,
});

function occurrence(id: string, startMs: number) {
  return {
    id,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + HOUR).toISOString(),
    completionStatus: "SCHEDULED",
    isTentative: false,
    deletedAt: null,
  };
}

const OCCURRENCES = [
  occurrence("occ-moving", MOVING),
  occurrence("occ-staying", STAYING),
];

function calendarData() {
  const cells = [
    cell(MOVING, "fully-booked"),
    cell(MOVING + ATOM, "fully-booked"),
    cell(MOVING + HOUR, "available"),
    cell(STAYING, "fully-booked"),
    cell(STAYING + ATOM, "fully-booked"),
    cell(STAYING + HOUR, "available"),
  ];
  return {
    consultantDetails: { id: "c1", name: "Hannah", timezone: "Asia/Kolkata" },
    serverCells: new Map(cells.map((c) => [c.startMs, c])),
    cellsWindow: {
      startMs: Date.UTC(2026, 10, 21, 18, 30),
      endMs: Date.UTC(2026, 10, 28, 18, 30),
    },
    availableSlots: [],
    eventSlots: [MOVING, MOVING + ATOM, STAYING, STAYING + ATOM].map(atom),
    eventTentativeSlots: [],
    eventOccurrences: OCCURRENCES,
    subscriptionMeta: null,
    quota: null,
    leadMs: null,
    loading: false,
    refreshing: false,
    error: null,
    eventSlotsFailed: false,
    availabilityFreshness: { freshness: "fresh", label: null, failed: false },
    refetch: jest.fn(),
    refetchAvailability: jest.fn(() => Promise.resolve()),
    refetchEventSlots: jest.fn(() => Promise.resolve()),
  };
}

function renderReschedule() {
  return render(
    <UnifiedCalendar
      consultantId="c1"
      eventType="subscription"
      eventId="sub-1"
      sessionDurationInHours={1}
      mode="select"
      viewerZone="Asia/Kolkata"
      focus={{ at: new Date(MOVING), precision: "session" }}
      releasingOccurrenceIds={["occ-moving"]}
    />,
  );
}

function cellAt(container: HTMLElement, startMs: number): HTMLElement {
  const found = container.querySelector(
    `[data-slot-start="${new Date(startMs).toISOString()}"]`,
  );
  if (!(found instanceof HTMLElement)) throw new Error("cell not rendered");
  return found;
}

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "queueMicrotask",
      "setImmediate",
      "nextTick",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mockToast.mockReset();
  mockToggleSlot.mockReset();
  mockCalendarData = calendarData();
});

describe("a session of this booking that is not being moved", () => {
  it("is not selectable and says why", () => {
    const { container } = renderReschedule();
    const staying = cellAt(container, STAYING);
    expect(staying.getAttribute("data-slot-state")).toBe("thisEvent");
    expect(staying.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(staying);

    expect(mockToggleSlot).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Another session of this booking" }),
    );
  });

  it("is never taken into a session that starts beside it", () => {
    const { container } = renderReschedule();
    // Thursday 11:00 is one free half-hour; the hour before it is the staying session.
    fireEvent.click(cellAt(container, STAYING + HOUR));

    expect(mockToggleSlot).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Not enough consecutive slots" }),
    );
  });

  it("leaves the session being moved pickable, overlapping its own time", () => {
    const { container } = renderReschedule();
    const moving = cellAt(container, MOVING + ATOM);
    expect(moving.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(moving);

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockToggleSlot).toHaveBeenCalledTimes(1);
    expect(
      mockToggleSlot.mock.calls[0][1].map((slot: CalendarInterval) =>
        slot.startTime.getTime(),
      ),
    ).toEqual([MOVING + ATOM, MOVING + HOUR]);
  });
});

describe("stayingSessionStarts", () => {
  it("lists the atoms of live sessions the reschedule does not release", () => {
    expect([...stayingSessionStarts(OCCURRENCES, ["occ-moving"])]).toEqual([
      STAYING,
      STAYING + ATOM,
    ]);
  });

  it("skips cancelled, removed and already released sessions", () => {
    const rows = [
      { ...occurrence("a", MOVING), completionStatus: "CANCELLED" },
      { ...occurrence("b", STAYING), deletedAt: "2026-11-17T00:00:00.000Z" },
      {
        ...occurrence("c", STAYING + 4 * HOUR),
        isTentative: true,
        completionStatus: "RESCHEDULED",
      },
    ];
    expect(stayingSessionStarts(rows, []).size).toBe(0);
  });
});

describe("selectionConflicts", () => {
  const context = (stayingStarts: ReadonlySet<number>): AtomContext => ({
    serverCells: new Map(
      [cell(STAYING, "fully-booked")].map((c) => [c.startMs, c]),
    ),
    eventStarts: new Set([STAYING]),
    tentativeStarts: new Set(),
    selectedStarts: new Set([STAYING]),
    justTakenStarts: new Set(),
    requestedStarts: new Set(),
    stayingStarts,
    nowMs: NOW,
  });
  const window = { startMs: NOW, endMs: NOW + 30 * 24 * HOUR };

  it("drops a pick that sits on a session no longer being moved", () => {
    expect(
      selectionConflicts([STAYING], context(new Set([STAYING])), window),
    ).toEqual(new Map([[STAYING, "ownSession"]]));
  });

  it("keeps a pick on a session that is being moved", () => {
    expect(selectionConflicts([STAYING], context(new Set()), window).size).toBe(
      0,
    );
  });
});
