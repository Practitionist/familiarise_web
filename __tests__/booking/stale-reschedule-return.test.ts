/**
 * @jest-environment node
 */

/**
 * A subscription session released for a reschedule and never re-placed goes
 * back to the plan after 30 days: the ghost hold is released by the CAS
 * helper with its reason, both parties are told in the same commit, and one
 * SystemEvent records it. The entitlement then offers the session again and
 * plan-end settlement refunds it if it is never placed.
 */

const STALE: Array<{
  id: string;
  appointmentId: string;
  startsAt: Date;
  consultantProfileId?: string;
}> = [
  {
    id: "occ-r1",
    appointmentId: "apt-1",
    startsAt: new Date("2026-08-01T04:30:00Z"),
  },
];
/** The rows the release's CAS actually moved, as its re-read sees them. */
const FREED: Array<{ id: string }> = [];

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentOccurrence: {
      // Only the stale-reschedule cohort read asks for RESCHEDULED rows.
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.completionStatus === "RESCHEDULED"
            ? STALE
            : where.completionStatus === "CANCELLED"
              ? FREED
              : [],
      ),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        id: "apt-1",
        organizationId: null,
        subscription: {
          id: "sub-1",
          requestedBy: { user: { id: "u-learner", name: "Asha" } },
          subscriptionPlan: {
            title: "Mentoring",
            consultantProfile: { user: { id: "u-expert", name: "Ravi" } },
          },
        },
      }),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    windowBackupInterest: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $disconnect: jest.fn(),
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = jest.fn().mockResolvedValue([]);
  return { __esModule: true, default: db };
});

const transitionOccurrenceCompletion = jest.fn(
  async (_tx: unknown, args: { where: { id?: { in?: string[] } } }) =>
    args.where.id?.in?.length ?? 0,
);
jest.mock("../../lib/booking/transitions", () => ({
  ...jest.requireActual("../../lib/booking/transitions"),
  transitionOccurrenceCompletion: (tx: unknown, args: never) =>
    transitionOccurrenceCompletion(tx, args),
}));
const stageBell = jest.fn(async (_tx: unknown, args: unknown) => ({
  staged: args,
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (tx: unknown, args: unknown) => stageBell(tx, args),
}));
const stageAppointmentCancelledEmail = jest.fn(async () => []);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: () => stageAppointmentCancelledEmail(),
}));
const flushNotificationsAfter = jest.fn(async () => {});
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: () => flushNotificationsAfter(),
}));
const recordSystemEvent = jest.fn(async (_args: unknown) => {});
jest.mock("../../lib/enterprise/system-events", () => ({
  ...jest.requireActual("../../lib/enterprise/system-events"),
  recordSystemEvent: (args: unknown) => recordSystemEvent(args),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({
  UNANSWERED_REQUEST_REASON: "unanswered",
  notifyConsulteeRequestExpired: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyUnscheduledSubscriptionNudge: jest
    .fn()
    .mockResolvedValue({ success: true }),
}));
jest.mock("../../lib/novu/outbox", () => ({
  deriveTransactionId: (...parts: unknown[]) => parts.join("|"),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1 },
  stageUnscheduledSubscriptionNudgeEmail: jest
    .fn()
    .mockResolvedValue({ staged: [], renderFailures: 0 }),
}));
const stageNoticesForFreedWindows = jest.fn(
  async (_tx: unknown, _host: string, _rows: Array<{ id: string }>) => {},
);
jest.mock("../../lib/booking/backup-interest", () => ({
  ...jest.requireActual("../../lib/booking/backup-interest"),
  stageNoticesForFreedWindows: (
    tx: unknown,
    host: string,
    rows: Array<{ id: string }>,
  ) => stageNoticesForFreedWindows(tx, host, rows),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import { expireStaleRequests } from "@/scripts/appointments/expire-stale-requests";

it("returns a stale released session to the plan and tells both parties", async () => {
  await expireStaleRequests();

  const release = transitionOccurrenceCompletion.mock.calls.find(
    ([, args]) => (args as { where: { id?: unknown } }).where.id !== undefined,
  );
  expect(release?.[1]).toMatchObject({
    where: { id: { in: ["occ-r1"] }, isTentative: true, deletedAt: null },
    to: "CANCELLED",
    fromIn: ["RESCHEDULED"],
    reason: "STALE_RESCHEDULE_RETURNED",
  });

  const recipients = stageBell.mock.calls.map(
    ([, args]) => (args as { recipients: string[] }).recipients[0],
  );
  expect(recipients.sort()).toEqual(["u-expert", "u-learner"]);
  expect(stageBell.mock.calls[0][1]).toMatchObject({
    payload: expect.objectContaining({
      planTitle: "Mentoring",
      reason: expect.stringContaining("went back to the plan"),
    }),
  });
  expect(stageAppointmentCancelledEmail).toHaveBeenCalledTimes(1);
  expect(recordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "BOOKING",
      context: expect.objectContaining({
        subscriptionId: "sub-1",
        released: 1,
      }),
    }),
  );
  expect(flushNotificationsAfter).toHaveBeenCalled();
});

it("tells waiters only about windows the release freed, under each row's host", async () => {
  STALE.splice(
    0,
    STALE.length,
    {
      id: "occ-a",
      appointmentId: "apt-1",
      startsAt: new Date("2026-08-01T04:30:00Z"),
      consultantProfileId: "cp-a",
    },
    {
      id: "occ-b",
      appointmentId: "apt-1",
      startsAt: new Date("2026-08-02T04:30:00Z"),
      consultantProfileId: "cp-b",
    },
    {
      id: "occ-c",
      appointmentId: "apt-1",
      startsAt: new Date("2026-08-03T04:30:00Z"),
      consultantProfileId: "cp-b",
    },
  );
  FREED.splice(0, FREED.length, { id: "occ-a" }, { id: "occ-c" });
  stageNoticesForFreedWindows.mockClear();

  await expireStaleRequests();

  expect(
    stageNoticesForFreedWindows.mock.calls.map(([, host, rows]) => [
      host,
      rows.map((r) => r.id),
    ]),
  ).toEqual([
    ["cp-a", ["occ-a"]],
    ["cp-b", ["occ-c"]],
  ]);
});
