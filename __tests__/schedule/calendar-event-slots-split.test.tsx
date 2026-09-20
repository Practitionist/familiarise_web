// Fresh holds must not paint as "Being moved".
//
// The calendar used to split this event's slots on `isTentative` alone, so a
// fresh REQUEST_SUBMITTED hold (tentative + SCHEDULED — those times ARE the
// request) rendered amber "Being moved" exactly like a genuine reschedule
// release (tentative + RESCHEDULED). The list and dialog already gate on the
// release predicate; the grid did not, sending consultants hunting for a
// reschedule that never happened (preview E2E on #1682).
//
// Assertions are on the hook's slot buckets, deliberately: the bug was in
// classification, not in cell paint.

jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: {
    fetchAvailabilitySlots: jest.fn(),
    fetchConsultantData: jest.fn(),
    fetchEventSlots: jest.fn(),
  },
}));

jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { useToast: () => ({ toast }) };
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useCalendarData,
  type UseCalendarDataOptions,
} from "../../hooks/scheduling/useCalendarData";
import { AllocationService } from "../../lib/scheduling/allocationService";

const fetchAvailabilitySlots =
  AllocationService.fetchAvailabilitySlots as jest.Mock;
const fetchConsultantData = AllocationService.fetchConsultantData as jest.Mock;
const fetchEventSlots = AllocationService.fetchEventSlots as jest.Mock;

let latest: ReturnType<typeof useCalendarData> | null = null;

function Probe({ options }: { options: UseCalendarDataOptions }) {
  latest = useCalendarData(options);
  return null;
}

let container: HTMLDivElement;
let root: Root;

const OPTIONS: UseCalendarDataOptions = {
  consultantId: "consultant-1",
  eventType: "consultation",
  eventId: "consult-1",
  view: "week",
  currentDate: new Date(2026, 2, 18, 12, 0, 0, 0),
  mode: "select",
};

function occurrence(
  startsAt: string,
  isTentative: boolean,
  completionStatus: string,
) {
  return {
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60 * 1000),
    isTentative,
    completionStatus,
  };
}

beforeEach(() => {
  fetchAvailabilitySlots.mockResolvedValue({ weekly: [], custom: [] });
  fetchConsultantData.mockResolvedValue({ id: "consultant-1", name: "Ada" });
  fetchEventSlots.mockResolvedValue({ data: [], weeklyConfirmedCallCounts: {} });
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

describe("event slot buckets distinguish fresh holds from releases", () => {
  it("puts fresh tentative holds in eventSlots, not eventTentativeSlots", async () => {
    fetchEventSlots.mockResolvedValue({
      data: [
        {
          id: "apt-1",
          appointmentType: "CONSULTATION",
          consultation: { status: "APPROVED" },
          occurrences: [
            occurrence("2026-03-18T10:00:00.000Z", true, "SCHEDULED"),
            occurrence("2026-03-18T10:30:00.000Z", true, "SCHEDULED"),
          ],
        },
      ],
      weeklyConfirmedCallCounts: {},
    });

    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });

    expect(latest?.eventSlots).toHaveLength(2);
    expect(latest?.eventTentativeSlots).toHaveLength(0);
  });

  it("keeps genuine reschedule releases in eventTentativeSlots", async () => {
    fetchEventSlots.mockResolvedValue({
      data: [
        {
          id: "apt-1",
          appointmentType: "CONSULTATION",
          consultation: { status: "APPROVED" },
          occurrences: [
            occurrence("2026-03-18T10:00:00.000Z", true, "RESCHEDULED"),
            occurrence("2026-03-18T10:30:00.000Z", true, "RESCHEDULED"),
          ],
        },
      ],
      weeklyConfirmedCallCounts: {},
    });

    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });

    expect(latest?.eventSlots).toHaveLength(0);
    expect(latest?.eventTentativeSlots).toHaveLength(2);
  });

  it("keeps confirmed slots in eventSlots", async () => {
    fetchEventSlots.mockResolvedValue({
      data: [
        {
          id: "apt-1",
          appointmentType: "CONSULTATION",
          consultation: { status: "APPROVED" },
          occurrences: [
            occurrence("2026-03-18T10:00:00.000Z", false, "SCHEDULED"),
          ],
        },
      ],
      weeklyConfirmedCallCounts: {},
    });

    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });

    expect(latest?.eventSlots).toHaveLength(1);
    expect(latest?.eventTentativeSlots).toHaveLength(0);
  });
});
