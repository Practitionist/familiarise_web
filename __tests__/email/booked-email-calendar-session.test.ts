/**
 * @jest-environment node
 */

// A late class enrolment's booked email names the next session ahead in its calendar link, not a past one.

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/email/preferences", () => ({
  loadEmailRecipients: jest.fn(async () => [
    {
      userId: "buyer",
      category: "appointments",
      email: "buyer@example.com",
      name: "Priya",
      zone: "Asia/Kolkata",
      allowed: true,
      unsubscribeUrl: null,
    },
  ]),
}));
const renderEmail = jest.fn(async (_element: unknown) => ({
  html: "<p>hi</p>",
  text: "hi",
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: (element: unknown) => renderEmail(element),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { stamp } from "../../lib/appointments/ics";
import {
  prepareBookedEmails,
  type AppointmentForEmails,
} from "../../lib/payments/webhooks/staged-emails";

const DAY = 24 * 3600_000;
const past = new Date(Date.now() - 2 * DAY);
const next = new Date(Date.now() + 2 * DAY);

it("links the next upcoming session when the first live one is already past", async () => {
  const appointment = {
    id: "appt-class",
    organizationId: null,
    occurrences: [
      { startsAt: past, endsAt: new Date(past.getTime() + 3600_000) },
      { startsAt: next, endsAt: new Date(next.getTime() + 3600_000) },
    ],
    class: {
      classPlan: {
        title: "Deep work",
        consultantProfile: { user: { id: "host", name: "Hannah" } },
        collaborators: [],
      },
    },
  } as unknown as AppointmentForEmails;
  const payment = {
    userId: "buyer",
    user: { name: "Priya" },
  } as unknown as Parameters<typeof prepareBookedEmails>[0];

  await prepareBookedEmails(payment, appointment, "CLASS");

  const element = renderEmail.mock.calls[0][0] as {
    props: { calendar?: { googleUrl: string } | null };
  };
  const dates = new URL(element.props.calendar!.googleUrl).searchParams.get(
    "dates",
  );
  expect(dates?.startsWith(stamp(next))).toBe(true);
});
