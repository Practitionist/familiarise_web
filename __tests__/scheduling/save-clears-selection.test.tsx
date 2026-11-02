/**
 * After a successful save the saved times are this booking's, not a
 * selection: the hook clears them before announcing success, so a refetch
 * that paints them booked can never be read as "just taken".
 */
import React, { useEffect } from "react";
import { act, render } from "@testing-library/react";

import type { CalendarInterval } from "@/lib/scheduling/calendarUtils";

jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/scheduling/allocationAlgorithms", () => ({
  AllocationAlgorithms: {
    manualAllocate: jest.fn(() =>
      Promise.resolve({ success: true, selectedSlots: [] }),
    ),
  },
}));

import {
  useEventSlotAllocation,
  type UseEventSlotAllocationReturn,
} from "@/hooks/scheduling/useScheduling";

const ATOM = 30 * 60 * 1000;
const START = Date.UTC(2030, 5, 12, 4, 30);
const picks: CalendarInterval[] = [0, 1].map((i) => ({
  startTime: new Date(START + i * ATOM),
  endTime: new Date(START + (i + 1) * ATOM),
  isAvailable: true,
  isBooked: false,
}));

let api: UseEventSlotAllocationReturn | null = null;
const selectionAtSuccess: number[] = [];

function Probe({ onSuccess }: Readonly<{ onSuccess: () => void }>) {
  const value = useEventSlotAllocation({
    eventType: "consultation",
    eventId: "consultation-1",
    consultantId: "consultant-1",
    durationInHours: 1,
    onSuccess,
  });
  useEffect(() => {
    api = value;
  });
  return <span data-count={value.selectedSlots.length} />;
}

describe("manual save success", () => {
  it("clears the selection before the host refetches", async () => {
    const view = render(
      <Probe
        onSuccess={() =>
          selectionAtSuccess.push(api?.selectedSlots.length ?? -1)
        }
      />,
    );
    act(() => api?.setSelectedSlots(picks));
    expect(view.container.querySelector("span")).toHaveAttribute(
      "data-count",
      "2",
    );

    await act(async () => {
      await api?.manualAllocate();
    });

    expect(view.container.querySelector("span")).toHaveAttribute(
      "data-count",
      "0",
    );
    expect(selectionAtSuccess).toHaveLength(1);
  });
});
