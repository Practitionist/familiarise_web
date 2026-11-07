/**
 * @jest-environment node
 */

/** Reminder fanout, staged-email replay, and required lease admission. */

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
      findFirst: jest.fn(async () => ({ id: "slot-1" })),
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
  default: {
    // Reminder delivery must work without a Redis claim.
    set: jest.fn(async () => {
      throw new Error("the reminder sweep must not depend on Redis");
    }),
    del: jest.fn(async () => undefined),
  },
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentReminder: jest.fn(async () => undefined),
}));
/**
 * The email twin has its own suite; leaving it real would drag the Resend
 * sender and the React templates into a test whose subject is the bell's
 * recipient list. The email type carries its real value; the ref builder is
 * stubbed in the legacy `appointment:<id>:<window>` shape, and the staged rows
 * below use that same shape, so the sweep's dedupe still matches them.
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
import redis from "../../lib/redis";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { CronLockUnavailableError } from "../../lib/cron/cron-lock-errors";
import { sendAppointmentReminderEmail } from "../../lib/email";
import { notifyAppointmentReminder } from "@/lib/novu/service";
import {
  REMINDER_WINDOWS,
  sendAppointmentReminders,
} from "@/scripts/appointments/send-appointment-reminders";
import { paidParticipant } from "@/lib/booking/participants";
import { TARGET_EVERY_MINUTES } from "@/lib/cron/schedule";

const bell = notifyAppointmentReminder as jest.Mock;
const redisSet = (redis as unknown as { set: jest.Mock }).set;
const redisDel = (redis as unknown as { del: jest.Mock }).del;
const stagedEmails = (
  prisma as unknown as { failedEmail: { findMany: jest.Mock } }
).failedEmail;

beforeEach(() => {
  // `clearMocks` clears call RECORDS, not implementations, so a resolved value
  // set inside one case is inherited by the next case in this file. The empty
  // staged-set is therefore re-pinned here rather than left in the factory.
  stagedEmails.findMany.mockResolvedValue([]);
  jest.mocked(withCronLock).mockImplementation((_name, _opts, fn) => fn());
});

it("reminds the attendee, the host and the accepted collaborator of a webinar", async () => {
  await sendAppointmentReminders();

  const recipients = bell.mock.calls[0][0];
  expect(recipients).toEqual(
    expect.arrayContaining(["u-attendee", "u-host", "u-cohost"]),
  );
  expect(recipients).toHaveLength(3);
});

it("sends the reminder without depending on Redis", async () => {
  // Redis availability must not decide whether an admitted run delivers.
  const result = await sendAppointmentReminders();

  expect(redisSet).not.toHaveBeenCalled();
  expect(redisDel).not.toHaveBeenCalled();
  // The mocked cohort returns the slot for every window, so the sweep rings
  // once per window. What matters is that it rang at all, and that the run
  // counted the send instead of dropping it.
  expect(bell).toHaveBeenCalledTimes(3);
  expect(result.reminders1h).toBe(1);
  expect(result.reminders24h).toBe(1);
  expect(result.reminders15m).toBe(1);
  expect(result.success).toBe(true);
});

it("skips the window whose email is already staged and still sends the other", async () => {
  // The dedupe key is per appointment AND window, so a staged 24h row
  // suppresses exactly one send: the 1h and 15m windows are still owed.
  stagedEmails.findMany.mockResolvedValue([
    { entityRef: "appointment:appt-1:24h" },
  ]);

  await sendAppointmentReminders();

  expect(bell).toHaveBeenCalledTimes(2);
  expect(bell.mock.calls[0][0]).toEqual(
    expect.arrayContaining(["u-attendee", "u-host", "u-cohost"]),
  );
});

it("skips staged sessions in the cohort read, so a full window still reaches its tail", async () => {
  const [template] = await slotFindMany();
  const window = Array.from({ length: 30 }, (_, i) => ({
    ...template,
    id: `slot-${i}`,
    appointment: { ...template.appointment, id: `appt-${i}` },
  }));
  const original = slotFindMany.getMockImplementation();
  slotFindMany.mockImplementation(async (...args: unknown[]) => {
    const { where, take } = args[0] as {
      where: { id?: { notIn: string[] }; startsAt: { gte: Date; lte: Date } };
      take: number;
    };
    return window
      .filter((s) => s.startsAt >= where.startsAt.gte)
      .filter((s) => s.startsAt <= where.startsAt.lte)
      .filter((s) => !where.id?.notIn.includes(s.id))
      .slice(0, take);
  });
  stagedEmails.findMany.mockResolvedValue(
    window.slice(0, 25).map((s) => ({ entityRef: `appointment:${s.id}:1h` })),
  );

  await sendAppointmentReminders();
  slotFindMany.mockImplementation(original);

  expect(bell).toHaveBeenCalledTimes(5);
});

it("refuses overlapping runs without a database lease and retries after recovery", async () => {
  jest
    .mocked(withCronLock)
    .mockImplementation((name, opts, fn) =>
      opts.failMode === "closed"
        ? Promise.reject(new CronLockUnavailableError(name))
        : fn(),
    );

  const results = await Promise.allSettled([
    sendAppointmentReminders(),
    sendAppointmentReminders(),
  ]);

  expect(results).toEqual([
    { status: "rejected", reason: expect.any(CronLockUnavailableError) },
    { status: "rejected", reason: expect.any(CronLockUnavailableError) },
  ]);
  expect(bell).not.toHaveBeenCalled();
  expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();

  jest.mocked(withCronLock).mockImplementation((_name, _opts, fn) => fn());
  await expect(sendAppointmentReminders()).resolves.toMatchObject({
    success: true,
    reminders1h: 1,
    reminders24h: 1,
  });
});

it("reminds paid seats only, in windows the job's cadence always reaches", async () => {
  await sendAppointmentReminders();

  const { include } = slotFindMany.mock.calls[0][0] as {
    include: { appointment: { include: { participants: { where: unknown } } } };
  };
  expect(include.appointment.include.participants.where).toEqual(
    paidParticipant(),
  );
  // One cadence plus a tick up to a minute late; staged rows dedupe a second hit.
  const cadenceMs =
    (TARGET_EVERY_MINUTES["appointment-reminders"] ?? 5) * 60_000;
  expect(REMINDER_WINDOWS.map((w) => w.label)).toEqual(["24h", "1h", "15m"]);
  for (const w of REMINDER_WINDOWS) {
    expect(w.maxMs - w.minMs).toBeGreaterThanOrEqual(cadenceMs + 60_000);
  }
  const [, oneHour, fifteen] = REMINDER_WINDOWS;
  expect(fifteen.minMs).toBeGreaterThan(0);
  expect(fifteen.maxMs).toBeLessThan(oneHour.minMs);
});
