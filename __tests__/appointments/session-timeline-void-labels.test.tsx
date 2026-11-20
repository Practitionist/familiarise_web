/**
 * A voided session is named by what happened to it: a platform issue, a
 * session cut short, a host who did not join. Neither the session timeline nor
 * the detail page's schedule calls a session both people attended a no-show,
 * and both read their words from one map.
 */

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TITLE,
  SessionTimeline,
  slotStatus,
} from "@/components/appointments/SessionTimeline";
import { SessionSchedule } from "@/components/appointments/detail/SessionSchedule";
import type { OccurrenceVM } from "@/lib/appointments/view-model";

const HOUR = 60 * 60 * 1000;

const past = (
  completionStatus: string,
  outcome: string | null,
): OccurrenceVM => ({
  occurrenceId: `occ-${completionStatus}-${outcome}`,
  appointmentId: "appt-1",
  startsAt: new Date(Date.now() - 3 * HOUR),
  endsAt: new Date(Date.now() - 2 * HOUR),
  isTentative: false,
  completionStatus,
  outcome,
  meetingEndedAt: null,
  meetingEndedReason: null,
});

const VOIDS = [
  [
    "PLATFORM_OUTAGE",
    "Platform issue",
    "A platform issue stopped this session.",
  ],
  [
    "CUT_SHORT",
    "Cut short",
    "This session ended earlier than the scheduled duration.",
  ],
  ["HOST_ABSENT", "Host did not join", "The host did not join this session."],
  [null, "Not held", "This session did not take place as booked."],
] as const;

describe("the session timeline", () => {
  it.each(VOIDS)("a session voided as %s reads %s", (outcome, label, title) => {
    render(<SessionTimeline occurrences={[past("VOIDED", outcome)]} />);
    expect(screen.getByText(label)).toHaveAttribute("title", title);
    expect(screen.queryByText(/no-show/i)).toBeNull();
    expect(screen.queryByTitle(/did not attend/)).toBeNull();
  });
});

describe("the detail page's schedule", () => {
  const open = (session: OccurrenceVM) => {
    render(<SessionSchedule occurrences={[session]} />);
    fireEvent.click(screen.getByRole("button", { name: "1 past session" }));
  };

  it.each(VOIDS)("a session voided as %s reads %s", (outcome, label, title) => {
    open(past("VOIDED", outcome));
    expect(screen.getByText(label)).toHaveAttribute("title", title);
    expect(screen.queryByText(/no-show/i)).toBeNull();
    expect(screen.queryByTitle(/did not attend/)).toBeNull();
  });

  it.each([
    ["COMPLETED", "HELD"],
    ["UNVERIFIED", "INCONCLUSIVE"],
    ["VOIDED", "CUT_SHORT"],
    ["VOIDED", "HOST_ABSENT"],
    ["VOIDED", "PLATFORM_OUTAGE"],
  ])("a %s / %s session reads the timeline's own word", (status, outcome) => {
    const session = past(status, outcome);
    const word = SESSION_STATUS_LABEL[slotStatus(session)];
    open(session);
    expect(screen.getByText(word).getAttribute("title")).toBe(
      SESSION_STATUS_TITLE[slotStatus(session)] ?? null,
    );
  });
});
