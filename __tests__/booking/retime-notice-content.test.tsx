/**
 * @jest-environment node
 */

/**
 * A host move tells each attendee how to keep or leave: the bell and the email
 * name the free full-refund deadline, and an attendee already busy at the new
 * time is told so first.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Liquid } from "liquidjs";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { NOVU_WORKFLOW_TEMPLATES } from "@/lib/novu/templates";
import AppointmentRescheduledEmail from "@/emails/booking/AppointmentRescheduledEmail";

const engine = new Liquid();
const bodyOf = (workflowId: string, payload: Record<string, unknown>) => {
  const template = NOVU_WORKFLOW_TEMPLATES.find(
    (t) => t.workflowId === workflowId,
  );
  if (!template) throw new Error(`no template for ${workflowId}`);
  return engine.parseAndRenderSync(template.inApp.body, { payload });
};

const LEAVE_BY = "Fri, 18 Sep 2026 · 9:00 AM IST";

describe("re-time bell", () => {
  const moved = {
    outcome: "MOVED",
    appointmentType: "webinar",
    planTitle: "Pitch clinic",
    oldDateTime: "Tue, 15 Sep 2026 · 4:30 PM IST",
    newDateTime: "Sat, 19 Sep 2026 · 4:30 PM IST",
  };

  it("offers keep-or-leave with the deadline", () => {
    expect(
      bodyOf(NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED, {
        ...moved,
        leaveBy: LEAVE_BY,
      }),
    ).toBe(
      `Your webinar for Pitch clinic moved from Tue, 15 Sep 2026 · 4:30 PM IST to Sat, 19 Sep 2026 · 4:30 PM IST. Keep your seat — nothing to do. Can't make it? Leave with a full refund until ${LEAVE_BY}.`,
    );
  });

  it("tells a busy attendee about the clash before the choice", () => {
    const body = bodyOf(NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED, {
      ...moved,
      leaveBy: LEAVE_BY,
      clash: true,
    });
    expect(body).toContain(
      "You already have a session then. Keep your seat — nothing to do.",
    );
  });

  it("keeps a 1:1 move plain", () => {
    expect(bodyOf(NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED, moved)).not.toMatch(
      /refund|already have/,
    );
  });
});

describe("make-up bell", () => {
  it("names the deadline and flags a clash", () => {
    const body = bodyOf(NOVU_WORKFLOWS.CLASS_MAKEUP_SCHEDULED, {
      planTitle: "Algebra 101",
      dateTime: "Sat, 19 Sep 2026 · 4:30 PM IST",
      leaveBy: LEAVE_BY,
      clash: true,
    });
    expect(body).toBe(
      `The make-up session of Algebra 101 is on Sat, 19 Sep 2026 · 4:30 PM IST. You already have a session then. Keep your seat — nothing to do. Can't make it? Leave the class with a full refund of the sessions still to come until ${LEAVE_BY}.`,
    );
  });
});

describe("re-time email", () => {
  const base = {
    outcome: "MOVED" as const,
    recipientName: "Asha",
    appointmentType: "webinar",
    oldStartsAtText: "Tue, 15 Sep 2026 at 4:30 PM IST",
    newStartsAtText: "Sat, 19 Sep 2026 at 4:30 PM IST",
    dashboardUrl: "https://app.test/dashboard",
  };

  it("offers keep-or-leave and flags a clash", () => {
    const html = renderToStaticMarkup(
      <AppointmentRescheduledEmail {...base} leaveByText={LEAVE_BY} clash />,
    );
    expect(html).toContain("You already have a session then.");
    expect(html).toContain(
      `Can&#x27;t make it? Leave with a full refund until ${LEAVE_BY}.`,
    );
  });

  it("says nothing about leaving when no free leave is open", () => {
    const html = renderToStaticMarkup(
      <AppointmentRescheduledEmail {...base} />,
    );
    expect(html).not.toMatch(/refund|already have/);
  });
});
