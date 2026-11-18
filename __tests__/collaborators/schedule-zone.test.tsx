/**
 * @jest-environment node
 */

/**
 * A collaboration card prints its sessions in the viewer's profile zone, the
 * zone the dashboard layout provides, and names that zone beside the hours.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "@/components/collaborators/ScheduleSummaries";
import type {
  ClassPlanSchedule,
  WebinarPlanSchedule,
} from "@/components/collaborators/types";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

const KATHMANDU = "Asia/Kathmandu";
const NEW_YORK = "America/New_York";

/** One session from 12:30 to 14:00 UTC on Wednesday 18 November 2026. */
const webinarPlan: WebinarPlanSchedule = {
  durationInHours: 1.5,
  maxParticipants: 50,
  webinars: [
    {
      id: "web-1",
      status: "SCHEDULED",
      appointment: {
        occurrences: [
          {
            startsAt: "2026-11-18T12:30:00.000Z",
            endsAt: "2026-11-18T14:00:00.000Z",
            isTentative: false,
          },
        ],
        _count: { participants: 5 },
      },
    },
  ],
};

/** A batch whose one session runs 20:30 to 21:30 UTC on Wednesday 15 January 2031. */
const classPlan: ClassPlanSchedule = {
  price: 500_000,
  sessionDurationInHours: 1,
  maxParticipants: 20,
  sessionsPerWeek: 1,
  totalSessions: 1,
  lateJoinUntilSession: null,
  classes: [
    {
      id: "class-1",
      status: "SCHEDULED",
      schedulingPeriodStartsAt: "2031-01-15T20:30:00.000Z",
      schedulingPeriodEndsAt: "2031-01-15T21:30:00.000Z",
      appointment: {
        occurrences: [
          {
            startsAt: "2031-01-15T20:30:00.000Z",
            endsAt: "2031-01-15T21:30:00.000Z",
            isTentative: false,
            ordinal: 1,
            completionStatus: "SCHEDULED",
            deletedAt: null,
          },
        ],
        _count: { participants: 3 },
      },
    },
  ],
};

const inZone = (zone: string, ui: React.ReactNode) =>
  renderToStaticMarkup(
    <DisplayZoneProvider zone={zone}>{ui}</DisplayZoneProvider>,
  );

describe("the schedule on a collaboration card", () => {
  it("prints a webinar's day and hours in the viewer's zone and names the zone", () => {
    const kathmandu = inZone(
      KATHMANDU,
      <WebinarScheduleSummary plan={webinarPlan} />,
    );
    expect(kathmandu).toContain("Wed, 18 Nov 2026");
    expect(kathmandu).toContain("6:15 PM – 7:45 PM GMT+5:45");

    const newYork = inZone(NEW_YORK, <WebinarEventList plan={webinarPlan} />);
    expect(newYork).toContain("Wed, 18 Nov 2026");
    expect(newYork).toContain("7:30 AM – 9:00 AM EST");
  });

  it("prints a class's next session and its batch on the viewer's calendar day", () => {
    // 20:30 UTC on the 15th is 02:15 on the 16th in Kathmandu.
    const summary = inZone(
      KATHMANDU,
      <ClassScheduleSummary plan={classPlan} />,
    );
    expect(summary).toContain("Next: Thu, 16 Jan 2031, 2:15 AM GMT+5:45");

    const list = inZone(NEW_YORK, <ClassEventList plan={classPlan} />);
    expect(list).toContain("Wed, 15 Jan 2031 – Wed, 15 Jan 2031");
  });
});
