/**
 * The schedule-type lock prints the form's reason as it stands: the reason is
 * already whole sentences, so nothing is glued after it.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

import { AvailabilitySection } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/AvailabilitySection";

const noop = () => undefined;
const section = (reason: string | null) => (
  <AvailabilitySection
    scheduleType="WEEKLY"
    canSwitchSchedule={false}
    scheduleSwitchBlockedReason={reason}
    onScheduleTypeChange={noop}
    weeklySlots={{}}
    customSlots={{}}
    currentDate={new Date("2026-11-19T00:00:00Z")}
    onPrevMonth={noop}
    onNextMonth={noop}
    onToggleCustomDate={noop}
    onAddSlot={noop}
    onUpdateSlot={noop}
    onDeleteSlot={noop}
    weeklyTimezone="Asia/Kolkata"
    profileTimezone="Asia/Kolkata"
    browserTimezone="Asia/Kolkata"
  />
);

it("prints the lock reason without a second sentence glued on", () => {
  const reason =
    "You have 1 active trial. Complete or cancel them before you switch schedule types.";
  render(section(reason));
  expect(screen.getByRole("alert").textContent).toBe(
    `Schedule Type Locked${reason}`,
  );
});
