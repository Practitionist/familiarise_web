/**
 * The release picker mirrors RELEASE_ONE_WEEK: a pick that would cross into a
 * second plan week is stopped with the server's sentence, and "Every session"
 * is off while the sessions span weeks.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  SessionReleasePicker,
  type ReleasableSession,
} from "@/components/scheduling/SessionReleasePicker";
import { RELEASE_ONE_WEEK_MESSAGE } from "@/lib/booking/release-weeks";

const DAY = 86_400_000;
const start = new Date(Date.now() + 3 * DAY);
const plan = {
  sessionsPerWeek: 2,
  durationInMonths: 1,
  schedulingPeriodStartsAt: start,
  schedulingTimezone: "UTC",
};
const session = (id: string, at: number): ReleasableSession => ({
  slots: [
    {
      id,
      appointmentId: "a",
      startsAt: new Date(at).toISOString(),
      isTentative: false,
    },
  ],
  startTime: new Date(at),
  endTime: new Date(at + 3_600_000),
});
// Week 1 holds two sessions; week 2 starts seven days after the period.
const sessions = [
  session("w1-a", start.getTime() + 2 * 3_600_000),
  session("w1-b", start.getTime() + 2 * DAY),
  session("w2-a", start.getTime() + 8 * DAY),
];

function renderPicker(mode: "multiple" | "entire", selected: string[]) {
  const onSelectionChange = jest.fn();
  const onModeChange = jest.fn();
  render(
    <SessionReleasePicker
      zone="UTC"
      sessions={sessions}
      minLeadHours={24}
      mode={mode}
      onModeChange={onModeChange}
      selectedSlotIds={selected}
      onSelectionChange={onSelectionChange}
      planWeek={plan}
    />,
  );
  return { onSelectionChange, onModeChange };
}

it("stops a pick that would cross into another plan week, with the server's sentence", () => {
  const { onSelectionChange } = renderPicker("multiple", ["w1-b"]);
  const rows = screen.getAllByRole("button", { pressed: false });
  fireEvent.click(rows[rows.length - 1]);
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(
    RELEASE_ONE_WEEK_MESSAGE,
  );
});

it("still adds a session in the same week", () => {
  const { onSelectionChange } = renderPicker("multiple", ["w1-b"]);
  fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]);
  expect(onSelectionChange).toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("offers no 'Every session' while the sessions span plan weeks", () => {
  renderPicker("multiple", ["w1-b"]);
  expect(screen.getByRole("radio", { name: /Every session/ })).toBeDisabled();
});

it("counts a lead-window session too, since 'Every session' releases it", () => {
  const begun = new Date(Date.now() - DAY);
  render(
    <SessionReleasePicker
      zone="UTC"
      sessions={[
        session("soon", Date.now() + 2 * 3_600_000),
        session("later", begun.getTime() + 8 * DAY),
      ]}
      minLeadHours={24}
      mode="multiple"
      onModeChange={jest.fn()}
      selectedSlotIds={[]}
      onSelectionChange={jest.fn()}
      planWeek={{ ...plan, schedulingPeriodStartsAt: begun }}
    />,
  );
  expect(screen.getByRole("radio", { name: /Every session/ })).toBeDisabled();
});
