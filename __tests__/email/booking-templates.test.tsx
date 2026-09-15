/**
 * @jest-environment node
 */

/**
 * #1653 — the six booking templates render inside the shared layout with
 * their subject-relevant interpolations and their CTA href in the HTML:
 * consultee versus consultant for booked, PROPOSED versus MOVED for
 * rescheduled, the join CTA for the reminder, and the two trial states.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AppointmentBookedEmail from "@/emails/booking/AppointmentBookedEmail";
import AppointmentCancelledEmail from "@/emails/booking/AppointmentCancelledEmail";
import AppointmentRescheduledEmail from "@/emails/booking/AppointmentRescheduledEmail";
import AppointmentReminderEmail from "@/emails/booking/AppointmentReminderEmail";
import NewBookingRequestEmail from "@/emails/booking/NewBookingRequestEmail";
import TrialScheduledEmail from "@/emails/booking/TrialScheduledEmail";

const when = "Tue, 15 Sep 2026 at 4:30 PM IST";
const later = "Wed, 16 Sep 2026 at 4:30 PM IST";
const dashboardUrl = "https://app.test/dashboard";
const unsubscribeUrl = "https://app.test/api/notifications/unsubscribe?t=x";

// `renderEmail()` goes through @react-email/render, whose dynamic import of
// react-dom/server needs --experimental-vm-modules under Jest; the static
// markup is the same tree, which is what these assertions read.
async function html(element: React.ReactElement): Promise<string> {
  return renderToStaticMarkup(element);
}

it("booked: consultee reads confirmed, consultant reads new booking", async () => {
  const base = {
    recipientName: "Asha",
    planTitle: "Interview prep",
    appointmentType: "consultation",
    startsAtText: when,
    dashboardUrl,
    unsubscribeUrl,
  };
  const consultee = await html(
    <AppointmentBookedEmail {...base} role="consultee" otherPartyName="Ravi" />,
  );
  expect(consultee).toContain("Your consultation with Ravi is confirmed");
  expect(consultee).toContain(when);
  expect(consultee).toContain(`href="${dashboardUrl}"`);
  expect(consultee).toContain(`href="${unsubscribeUrl}"`);

  const consultant = await html(
    <AppointmentBookedEmail
      {...base}
      role="consultant"
      otherPartyName="Asha"
    />,
  );
  expect(consultant).toContain("New booking: Asha for Interview prep");
});

it("cancelled: names who cancelled, the reason and the refund line", async () => {
  const out = await html(
    <AppointmentCancelledEmail
      recipientName="Asha"
      startsAtText={when}
      cancelledBy="Ravi"
      reason="Travelling that week"
      refundText="A refund of ₹1,200 is on its way"
      dashboardUrl={dashboardUrl}
    />,
  );
  expect(out).toContain(`Your session on ${when} was cancelled`);
  expect(out).toContain("Travelling that week");
  expect(out).toContain("₹1,200");
  expect(out).toContain(`href="${dashboardUrl}"`);
});

it("rescheduled: PROPOSED carries the deadline, MOVED is informational", async () => {
  const base = {
    recipientName: "Asha",
    appointmentType: "consultation",
    oldStartsAtText: when,
    newStartsAtText: later,
    dashboardUrl,
  };
  const proposed = await html(
    <AppointmentRescheduledEmail
      {...base}
      outcome="PROPOSED"
      proposedBy="Ravi"
      respondByText="Mon, 14 Sep 2026 at 4:30 PM IST"
    />,
  );
  expect(proposed).toContain("New time proposed for your consultation");
  expect(proposed).toContain("Mon, 14 Sep 2026 at 4:30 PM IST");
  expect(proposed).toContain("Review the new time");

  const moved = await html(
    <AppointmentRescheduledEmail {...base} outcome="MOVED" />,
  );
  expect(moved).toContain("Your consultation has moved");
  expect(moved).toContain(later);
  expect(moved).not.toContain("before it lapses");
});

it("reminder: joins when a join link is known, else views the booking", async () => {
  const base = {
    recipientName: "Asha",
    otherPartyName: "Ravi",
    planTitle: "Interview prep",
    appointmentType: "consultation",
    startsAtText: when,
    windowLabel: "in about an hour",
    dashboardUrl,
  };
  const withJoin = await html(
    <AppointmentReminderEmail
      {...base}
      joinUrl="https://app.test/meetings/m1"
    />,
  );
  expect(withJoin).toContain("Reminder: your consultation is coming up");
  expect(withJoin).toContain("Join session");
  expect(withJoin).toContain('href="https://app.test/meetings/m1"');

  const without = await html(<AppointmentReminderEmail {...base} />);
  expect(without).toContain("View booking");
  expect(without).toContain(`href="${dashboardUrl}"`);
});

it("new request: names the consultee, the time and the deadline", async () => {
  const out = await html(
    <NewBookingRequestEmail
      consultantName="Ravi"
      consulteeName="Asha"
      planTitle="Interview prep"
      appointmentType="consultation"
      requestedAtText={when}
      respondByText={later}
      reviewUrl="https://app.test/dashboard/consultant/c1/requests"
    />,
  );
  expect(out).toContain("Asha requested a consultation with you");
  expect(out).toContain(later);
  expect(out).toContain(
    'href="https://app.test/dashboard/consultant/c1/requests"',
  );
});

it("trial: confirmed versus held until payment completes", async () => {
  const base = {
    role: "consultee" as const,
    recipientName: "Asha",
    otherPartyName: "Ravi",
    planTitle: "Interview prep",
    startsAtText: when,
    dashboardUrl,
  };
  const confirmed = await html(
    <TrialScheduledEmail {...base} awaitingPayment={false} />,
  );
  expect(confirmed).toContain("Your free trial with Ravi is confirmed");
  expect(confirmed).toContain("View trial");

  const held = await html(<TrialScheduledEmail {...base} awaitingPayment />);
  expect(held).toContain("held until payment completes");
  expect(held).toContain("Complete payment");
});
