/**
 * A 409 TIMES_TAKEN names the times someone else took: only those leave the
 * selection, and the message lists them in the grid's zone.
 */
import React, { useEffect } from "react";
import { act, render } from "@testing-library/react";

import type { CalendarInterval } from "@/lib/scheduling/calendarUtils";

const ATOM = 30 * 60 * 1000;
const FIRST = Date.UTC(2030, 5, 12, 4, 30);
const SECOND = Date.UTC(2030, 5, 13, 4, 30);

const mockToast = jest.fn();
jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/scheduling/allocationAlgorithms", () => ({
  AllocationAlgorithms: {
    manualAllocate: jest.fn(() =>
      Promise.resolve({
        success: false,
        selectedSlots: [],
        httpStatus: 409,
        errorCode: "TIMES_TAKEN",
        takenSlotStarts: [new Date(Date.UTC(2030, 5, 12, 4, 30)).toISOString()],
      }),
    ),
  },
}));

import {
  useEventSlotAllocation,
  type UseEventSlotAllocationReturn,
} from "@/hooks/scheduling/useScheduling";

const atoms = (startMs: number): CalendarInterval[] =>
  [0, 1].map((i) => ({
    startTime: new Date(startMs + i * ATOM),
    endTime: new Date(startMs + (i + 1) * ATOM),
    isAvailable: true,
    isBooked: false,
  }));

let api: UseEventSlotAllocationReturn | null = null;
const onStaleData = jest.fn();

function Probe() {
  const value = useEventSlotAllocation({
    eventType: "subscription",
    eventId: "subscription-1",
    consultantId: "consultant-1",
    sessionDurationInHours: 1,
    sessionsPerWeek: 2,
    startDate: new Date(Date.UTC(2030, 5, 10)),
    endDate: new Date(Date.UTC(2030, 5, 17)),
    maxTotalCalls: 2,
    displayZone: "Asia/Kolkata",
    onStaleData,
  });
  useEffect(() => {
    api = value;
  });
  return (
    <span
      data-starts={value.selectedSlots
        .map((s) => s.startTime.getTime())
        .join(",")}
    />
  );
}

describe("409 TIMES_TAKEN", () => {
  it("drops only the taken session, keeps the other picks and names the time", async () => {
    jest.useFakeTimers();
    const view = render(<Probe />);
    act(() => api?.setSelectedSlots([...atoms(FIRST), ...atoms(SECOND)]));

    await act(async () => {
      await api?.manualAllocate();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(view.container.querySelector("span")).toHaveAttribute(
      "data-starts",
      `${SECOND},${SECOND + ATOM}`,
    );
    expect(onStaleData).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "This time was just taken",
        description: expect.stringMatching(/10:00\s?am/i),
      }),
    );
    jest.useRealTimers();
  });
});
