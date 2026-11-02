/**
 * Release by occurrence: a subscription is one appointment carrying many
 * sessions, so each live occurrence is one releasable session. And picking
 * times works on a phone: the day list replaces the grid, and the release
 * step plus "Any time works" stay reachable.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import type { OccurrenceLike } from "@/lib/appointments/view-model";

jest.mock("@/components/scheduling/SafeUnifiedCalendar", () => ({
  SafeUnifiedCalendar: () => <div data-testid="week-grid" />,
}));
jest.mock("@/components/scheduling/MobileDayListPicker", () => ({
  MobileDayListPicker: (props: { timesNeeded: number; zone: string }) => (
    <div
      data-testid="day-list"
      data-times-needed={props.timesNeeded}
      data-zone={props.zone}
    />
  ),
}));
jest.mock("@/lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));

import { groupReleasableSessions } from "@/components/scheduling/SessionReleasePicker";
import { TimePicker } from "@/components/scheduling/TimePicker";
import {
  rescheduleConsulteePolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";

const DAY = 24 * 60 * 60 * 1000;
const base = Date.now() + 10 * DAY;

function occurrence(
  index: number,
  extra: Partial<OccurrenceLike> = {},
): OccurrenceLike {
  return {
    id: `occ-${index}`,
    appointmentId: "appointment-1",
    startsAt: new Date(base + index * 7 * DAY).toISOString(),
    endsAt: new Date(base + index * 7 * DAY + 60 * 60 * 1000).toISOString(),
    isTentative: false,
    completionStatus: null,
    deletedAt: null,
    ...extra,
  };
}

function setViewport(wide: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: wide,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

const subject: TimePickerSubject = {
  consultantProfileId: "consultant-1",
  eventType: "subscription",
  eventId: "subscription-1",
  sessionDurationInHours: 1,
  slots: [occurrence(0), occurrence(1), occurrence(2)],
};

describe("groupReleasableSessions", () => {
  it("makes one session per live occurrence, even under one appointment", () => {
    const sessions = groupReleasableSessions([
      occurrence(0),
      occurrence(1),
      occurrence(2),
      occurrence(3, { deletedAt: new Date().toISOString() }),
      occurrence(4, { completionStatus: "CANCELLED" }),
      occurrence(5, { isTentative: true, completionStatus: "RESCHEDULED" }),
    ]);
    expect(
      sessions.map((session) => session.slots.map((slot) => slot.id)),
    ).toEqual([["occ-0"], ["occ-1"], ["occ-2"]]);
  });
});

describe("TimePicker for a subscription reschedule", () => {
  it("offers the release step and asks for one time per session", async () => {
    setViewport(true);
    render(
      <TimePicker
        policy={rescheduleConsulteePolicy({ onSubmit: jest.fn() })}
        subject={subject}
        viewerZone="Asia/Kolkata"
      />,
    );
    expect(await screen.findByTestId("week-grid")).toBeInTheDocument();
    expect(screen.getByText("What is moving?")).toBeInTheDocument();
    expect(
      screen.getByText("All 3 sessions are released."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pick 3 times\./)).toBeInTheDocument();
  });

  it("on a phone shows the day list, and Any time works stays reachable", async () => {
    setViewport(false);
    const onSubmit = jest.fn();
    render(
      <TimePicker
        policy={rescheduleConsulteePolicy({ onSubmit })}
        subject={subject}
        viewerZone="Asia/Kolkata"
      />,
    );
    const dayList = await screen.findByTestId("day-list");
    expect(dayList).toHaveAttribute("data-times-needed", "3");
    expect(dayList).toHaveAttribute("data-zone", "Asia/Kolkata");
    expect(screen.queryByTestId("week-grid")).not.toBeInTheDocument();
    expect(screen.queryByText(/desktop/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Any time works" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ proposedSlots: undefined }),
    );
  });
});
