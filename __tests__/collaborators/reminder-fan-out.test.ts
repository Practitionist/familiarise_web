/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-5 — a group event's reminder used to reach only the users joined
 * to the slot: neither the host nor the accepted collaborators. Both are on
 * the recipient list now, read through `collaboratorUserIds`.
 *
 * The second case pins the durable half of the dedupe that reordered this
 * sweep: the email twin stages its `FailedEmail` row BEFORE it sends, and the
 * next run reads that set back, so a run that died mid-window is re-drivable
 * per window rather than re-sent or lost.
 */

const slotFindMany = jest.fn(async (..._args: unknown[]) => [
  {
    id: "slot-1",
    startsAt: new Date(Date.now() + 60 * 60_000),
    appointment: {
      id: "appt-1",
      organizationId: null,
      participants: [{ userId: "u-attendee" }],
      consultation: null,
      subscription: null,
      class: null,
      webinar: {
        id: "web-1",
        webinarPlanId: "wp-1",
        webinarPlan: {
          title: "W",
          consultantProfile: { userId: "u-host", user: { name: "Host" } },
        },
      },
    },
  },
]);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: (...a: unknown[]) => slotFindMany(...a),
    },
    collaborator: {
      findMany: jest.fn(async () => [
        { consultantProfile: { userId: "u-cohost" } },
      ]),
    },
    // The staged-email set the sweep reads back before it sends anything. It is
    // read INSIDE the per-window scan, ahead of the bell, so a mock without
    // this model throws there and no recipient is ever reached — which is how
    // this file failed while the sweep was being reordered.
    failedEmail: { findMany: jest.fn(async () => []) },
    $disconnect: jest.fn(),
  },
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(async () => "OK") },
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentReminder: jest.fn(async () => undefined),
}));
/**
 * The email twin has its own suite; leaving it real would drag the Resend
 * sender and the React templates into a test whose subject is the bell's
 * recipient list. The two constants carry their REAL values, because the sweep
 * uses them to build the `entityRef` it dedupes against — a stubbed ref format
 * here would stop matching the rows the twin stages and make the second case
 * below pass for the wrong reason.
 */
jest.mock("../../lib/email", () => ({
  APPOINTMENT_REMINDER_EMAIL_TYPE: "APPOINTMENT_REMINDER",
  appointmentReminderEntityRef: (appointmentId: string, windowLabel: string) =>
    `appointment:${appointmentId}:${windowLabel}`,
  EMAIL_BUDGET_MS: { JOB: 1 },
  sendAppointmentReminderEmail: jest.fn(async () => ({
    sent: 0,
    skipped: 0,
    failed: 0,
  })),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import prisma from "../../lib/prisma";
import { notifyAppointmentReminder } from "@/lib/novu/service";
import { sendAppointmentReminders } from "@/scripts/appointments/send-appointment-reminders";

const bell = notifyAppointmentReminder as jest.Mock;
const stagedEmails = (
  prisma as unknown as { failedEmail: { findMany: jest.Mock } }
).failedEmail;

beforeEach(() => {
  // `clearMocks` clears call RECORDS, not implementations, so a resolved value
  // set inside one case is inherited by the next case in this file. The empty
  // staged-set is therefore re-pinned here rather than left in the factory.
  stagedEmails.findMany.mockResolvedValue([]);
});

it("reminds the attendee, the host and the accepted collaborator of a webinar", async () => {
  await sendAppointmentReminders();

  const recipients = bell.mock.calls[0][0];
  expect(recipients).toEqual(
    expect.arrayContaining(["u-attendee", "u-host", "u-cohost"]),
  );
  expect(recipients).toHaveLength(3);
});

it("skips the window whose email is already staged and still sends the other", async () => {
  // The dedupe key is per appointment AND window, so a staged 24h row
  // suppresses exactly one of the two sends: the 1h window is still owed.
  stagedEmails.findMany.mockResolvedValue([
    { entityRef: "appointment:appt-1:24h" },
  ]);

  await sendAppointmentReminders();

  expect(bell).toHaveBeenCalledTimes(1);
  expect(bell.mock.calls[0][0]).toEqual(
    expect.arrayContaining(["u-attendee", "u-host", "u-cohost"]),
  );
});
