/**
 * A poll that turns a picked time busy paints it "Just taken" for the render
 * that reveals it, then drops the whole session from the selection and says
 * so — instead of keeping a green "Selected" cell that only a 409 exposes.
 */
import React from "react";
import { act, render } from "@testing-library/react";

import type { CalendarInterval } from "@/lib/scheduling/calendarUtils";
import type { SlotStatusKey } from "@/lib/scheduling/interval-status-tokens";
import type { ServerCell } from "@/lib/scheduling/week-grid-model";

const ATOM = 30 * 60 * 1000;
const T = Math.ceil((Date.now() + 2 * 24 * 60 * 60 * 1000) / ATOM) * ATOM;

const mockToast = jest.fn();
const mockRemoveSlots = jest.fn();
let mockInitialSelection: CalendarInterval[] = [];
let mockIsAllocating = false;
let mockCalendarData: Record<string, unknown> = {};

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("@/hooks/scheduling/useCalendarData", () => ({
  useCalendarData: () => mockCalendarData,
}));

jest.mock("@/hooks/scheduling/useScheduling", () => {
  const ReactInMock: typeof React = jest.requireActual("react");
  return {
    earliestSelectedSlot: (slots: CalendarInterval[]) => slots[0] ?? null,
    useEventSlotAllocation: () => {
      const [selectedSlots, setSelectedSlots] =
        ReactInMock.useState(mockInitialSelection);
      const removeSlots = ReactInMock.useCallback(
        (drop: CalendarInterval[]) => {
          mockRemoveSlots(drop);
          const gone = new Set(drop.map((slot) => slot.startTime.getTime()));
          setSelectedSlots((current) =>
            current.filter((slot) => !gone.has(slot.startTime.getTime())),
          );
        },
        [],
      );
      return {
        selectedSlots,
        isAllocating: mockIsAllocating,
        allocationError: null,
        isValid: true,
        validationErrors: [],
        requiredSlots: 2,
        toggleSlot: jest.fn(),
        clearSlots: jest.fn(),
        removeSlots,
        manualAllocate: jest.fn(),
        autoAllocate: jest.fn(),
        partialOffer: null,
        dismissPartialOffer: jest.fn(),
        slotLimits: { slotsPerSession: 2, maxSlots: 2, totalSessions: 1 },
      };
    },
  };
});

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

function calendarData(cells: ServerCell[], eventSlotsFailed = false) {
  return {
    consultantDetails: { id: "c1", name: "Ada", timezone: "Asia/Kolkata" },
    serverCells: new Map(cells.map((c) => [c.startMs, c])),
    cellsWindow: {
      startMs: T - 4 * 24 * 60 * 60 * 1000,
      endMs: T + 4 * 24 * 60 * 60 * 1000,
    },
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
    eventSlotsFailed,
    availabilityFreshness: { freshness: "fresh", label: null, failed: false },
    refetch: jest.fn(),
    refetchAvailability: jest.fn(() => Promise.resolve()),
    refetchEventSlots: jest.fn(() => Promise.resolve()),
  };
}

const slot = (startMs: number): CalendarInterval => ({
  startTime: new Date(startMs),
  endTime: new Date(startMs + ATOM),
  isAvailable: true,
  isBooked: false,
});

function renderCalendar(onPainted: (keys: ReadonlySet<SlotStatusKey>) => void) {
  return render(
    <UnifiedCalendar
      consultantId="c1"
      eventType="consultation"
      durationInHours={1}
      mode="select"
      viewerZone="Asia/Kolkata"
      focus={{ at: new Date(T), precision: "session" }}
      onPaintedKeysChange={onPainted}
    />,
  );
}

beforeEach(() => {
  mockToast.mockReset();
  mockRemoveSlots.mockReset();
  mockInitialSelection = [slot(T), slot(T + ATOM)];
  mockIsAllocating = false;
});

describe("a picked time that a poll shows taken", () => {
  it("paints Just taken once, then drops the whole session and says so", () => {
    const painted: SlotStatusKey[][] = [];
    mockCalendarData = calendarData([
      cell(T, "available"),
      cell(T + ATOM, "available"),
    ]);
    const view = renderCalendar((keys) => painted.push([...keys]));
    expect(painted.at(-1)).toContain("selected");
    expect(painted.flat()).not.toContain("justTaken");

    mockCalendarData = calendarData([
      cell(T, "fully-booked"),
      cell(T + ATOM, "available"),
    ]);
    act(() => {
      view.rerender(
        <UnifiedCalendar
          consultantId="c1"
          eventType="consultation"
          durationInHours={1}
          mode="select"
          viewerZone="Asia/Kolkata"
          focus={{ at: new Date(T), precision: "session" }}
          onPaintedKeysChange={(keys) => painted.push([...keys])}
        />,
      );
    });

    // The revealing render painted it...
    expect(painted.some((keys) => keys.includes("justTaken"))).toBe(true);
    // ...then the session (both half-hours) left the selection.
    expect(mockRemoveSlots).toHaveBeenCalledTimes(1);
    expect(
      mockRemoveSlots.mock.calls[0][0].map((s: CalendarInterval) =>
        s.startTime.getTime(),
      ),
    ).toEqual([T, T + ATOM]);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "One of your chosen times was just taken",
      }),
    );
    const last = painted.at(-1) ?? [];
    expect(last).not.toContain("justTaken");
    expect(last).not.toContain("selected");
    expect(last).toContain("fullyBooked");
  });

  it("leaves a selection outside the fetched window alone", () => {
    mockInitialSelection = [slot(T + 30 * 24 * 60 * 60 * 1000)];
    mockCalendarData = calendarData([cell(T, "fully-booked")]);
    renderCalendar(() => {});
    expect(mockRemoveSlots).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("is not judged while a save is in flight", () => {
    mockIsAllocating = true;
    mockCalendarData = calendarData([
      cell(T, "fully-booked"),
      cell(T + ATOM, "available"),
    ]);
    renderCalendar(() => {});
    expect(mockRemoveSlots).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("is not judged while this booking's own sessions failed to load", () => {
    mockCalendarData = calendarData(
      [cell(T, "fully-booked"), cell(T + ATOM, "available")],
      true,
    );
    renderCalendar(() => {});
    expect(mockRemoveSlots).not.toHaveBeenCalled();
  });
});
