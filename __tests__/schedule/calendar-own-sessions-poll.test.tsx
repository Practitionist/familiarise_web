/**
 * This booking's own sessions outrank the server cell, so they are re-read
 * whenever a poll answers a changed body: a session cancelled elsewhere stops
 * painting "This booking" on the poll that frees its cell.
 */

jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: {
    fetchAvailabilitySlots: jest.fn(),
    fetchConsultantData: jest.fn(),
    fetchEventSlots: jest.fn(),
  },
}));

jest.mock("../../lib/scheduling/availabilityPolling", () => ({
  ...jest.requireActual("../../lib/scheduling/availabilityPolling"),
  availabilityPollJitterMs: () => 0,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useCalendarData,
  type UseCalendarDataOptions,
} from "../../hooks/scheduling/useCalendarData";
import { AVAILABILITY_POLL_INTERVAL_MS } from "../../lib/scheduling/availabilityPolling";
import { AllocationService } from "../../lib/scheduling/allocationService";

const fetchAvailabilitySlots =
  AllocationService.fetchAvailabilitySlots as jest.Mock;
const fetchConsultantData = AllocationService.fetchConsultantData as jest.Mock;
const fetchEventSlots = AllocationService.fetchEventSlots as jest.Mock;

const OPTIONS: UseCalendarDataOptions = {
  consultantId: "consultant-1",
  eventType: "subscription",
  eventId: "sub-1",
  view: "week",
  currentDate: new Date(2026, 10, 25, 12, 0, 0, 0),
  mode: "allocate",
};

const SESSION_START = "2026-11-24T04:30:00.000Z";
const SESSION_END = "2026-11-24T05:00:00.000Z";

const ONE_OWN_SESSION = {
  data: [
    {
      id: "apt-1",
      appointmentType: "SUBSCRIPTION",
      subscription: { status: "ACTIVE" },
      occurrences: [
        {
          startsAt: SESSION_START,
          endsAt: SESSION_END,
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ],
    },
  ],
};

function body(bookingStatus: "available" | "fully-booked", etag: string) {
  return {
    weekly: [
      {
        slotId: "s1",
        startsAt: SESSION_START,
        endsAt: SESSION_END,
        bookingStatus,
        type: "WEEKLY",
      },
    ],
    custom: [],
    quota: null,
    leadMs: null,
    etag,
    notModified: false,
  };
}

let latest: ReturnType<typeof useCalendarData> | null = null;

function Probe({ options }: { options: UseCalendarDataOptions }) {
  latest = useCalendarData(options);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchConsultantData.mockResolvedValue({ id: "consultant-1", name: "Ada" });
  fetchAvailabilitySlots.mockResolvedValue(body("fully-booked", '"a"'));
  fetchEventSlots.mockResolvedValue(ONE_OWN_SESSION);
  jest.useFakeTimers({
    doNotFake: ["queueMicrotask", "setImmediate", "nextTick"],
  });
  latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.clearAllMocks();
});

async function poll() {
  await act(async () => {
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS + 1_000);
  });
}

describe("own sessions follow the availability poll", () => {
  it("re-reads them when the poll answers a changed body", async () => {
    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });
    expect(latest?.eventSlots).toHaveLength(1);
    expect(fetchEventSlots).toHaveBeenCalledTimes(1);

    // The session was cancelled elsewhere: its cell is free and the booking no longer owns it.
    fetchAvailabilitySlots.mockResolvedValue(body("available", '"b"'));
    fetchEventSlots.mockResolvedValue({ data: [] });
    await poll();

    expect(fetchEventSlots).toHaveBeenCalledTimes(2);
    expect(latest?.eventSlots).toHaveLength(0);
    expect(
      latest?.serverCells.get(new Date(SESSION_START).getTime())?.bookingStatus,
    ).toBe("available");
  });

  it("does not re-read them on a 304", async () => {
    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });
    expect(fetchEventSlots).toHaveBeenCalledTimes(1);

    fetchAvailabilitySlots.mockResolvedValue({
      etag: '"a"',
      notModified: true,
    });
    await poll();

    expect(fetchAvailabilitySlots.mock.calls.length).toBeGreaterThan(1);
    expect(fetchEventSlots).toHaveBeenCalledTimes(1);
    expect(latest?.eventSlots).toHaveLength(1);
  });
});
