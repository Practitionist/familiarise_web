/**
 * The reminder scan: the consultant's own zone (their user's) decides when,
 * one bell and one email per consultant list every plan due, and consultants
 * are read from an hourly rotating offset, each with every plan, so nobody
 * past the budget is missed and no consultant's group is split.
 */
const mockPrisma = {
  consultantProfile: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  subscription: { findMany: jest.fn() },
  notificationPreference: { findMany: jest.fn() },
  notificationOutbox: { findMany: jest.fn() },
  failedEmail: { findMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
const mockNotify = jest.fn();
jest.mock("../../lib/novu/service", () => ({
  notifyUnplacedWeekNudge: (...args: unknown[]) => mockNotify(...args),
}));
const mockSendEmail = jest.fn();
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1000 },
  SUBSCRIPTION_WEEK_NUDGE_EMAIL_TYPE: "SUBSCRIPTION_WEEK_NUDGE",
  sendUnplacedWeekNudgeEmail: (...args: unknown[]) => mockSendEmail(...args),
  unplacedWeekNudgeEntityRef: (id: string, day: string) => `${id}:${day}`,
}));
jest.mock("../../lib/novu/outbox", () => ({
  deriveTransactionId: (...args: unknown[]) => JSON.stringify(args),
}));

import {
  nudgeUnplacedPlanWeeks,
  rotationOffset,
} from "../../lib/booking/week-nudge";

const HOUR = 3_600_000;
// Mon 2 Mar 2026 00:00 IST; week 2 opens 8 Mar 18:30Z, which is 18:30 in
// London, so a London consultant's ladder starts 9 Mar 09:00Z.
const START = new Date("2026-03-01T18:30:00.000Z");

const delivered = [0, 2, 4].map((day) => {
  const startsAt = new Date(START.getTime() + (day * 24 + 10) * HOUR);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus: "COMPLETED",
    isTentative: false,
    deletedAt: null,
  };
});

const sub = (id: string, consulteeName: string, startDayOffset = 0) => ({
  id,
  sessionsTotal: 72,
  sessionsRefunded: 0,
  schedulingPeriodStartsAt: new Date(
    START.getTime() + startDayOffset * 24 * HOUR,
  ),
  schedulingTimezone: "Asia/Kolkata",
  planEndsAt: null,
  requestedBy: { user: { name: consulteeName } },
  subscriptionPlan: {
    title: "Weekly coaching",
    totalSessions: 72,
    sessionsPerWeek: 3,
    durationInMonths: 6,
    consultantProfile: {
      id: "cp-1",
      user: { id: "user-1", timezone: "Europe/London" },
    },
  },
  appointment: { occurrences: delivered },
});

function runAt(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout"],
  });
  return nudgeUnplacedPlanWeeks({ maxRequests: 1000 });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.consultantProfile.count.mockResolvedValue(1);
  mockPrisma.consultantProfile.findMany.mockResolvedValue([{ id: "cp-1" }]);
  mockPrisma.subscription.findMany.mockResolvedValue([
    sub("sub-a", "Priya"),
    sub("sub-b", "Ravi"),
  ]);
  mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
  mockPrisma.notificationOutbox.findMany.mockResolvedValue([]);
  mockPrisma.failedEmail.findMany.mockResolvedValue([]);
  mockSendEmail.mockResolvedValue({ sent: 1, failed: 0 });
});
afterEach(() => jest.useRealTimers());

it("waits for the consultant's own morning, not the plan's zone", async () => {
  // 04:00 in London (09:30 in Kolkata, where the plan was bought).
  expect((await runAt("2026-03-09T04:00:00.000Z")).nudged).toBe(0);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockSendEmail).not.toHaveBeenCalled();
});

it("sends one bell and one email per consultant listing every plan due", async () => {
  expect((await runAt("2026-03-09T10:00:00.000Z")).nudged).toBe(1);
  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockNotify.mock.calls[0][1].weekSummary).toBe(
    "Priya's week 2 (3 sessions) and 1 more plan need session times this week.",
  );
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
    consultantProfileId: "cp-1",
    localDay: "2026-03-09",
    weeks: [
      { consulteeName: "Priya", number: 2, sessions: 3 },
      { consulteeName: "Ravi", number: 2, sessions: 3 },
    ],
  });
});

it("holds the email and the bell while the consultant is inside their quiet hours", async () => {
  mockPrisma.notificationPreference.findMany.mockResolvedValue([
    {
      userId: "user-1",
      quietHoursStart: "09:30",
      quietHoursEnd: "11:00",
      quietHoursTimezone: "Europe/London",
    },
  ]);

  expect((await runAt("2026-03-09T10:00:00.000Z")).nudged).toBe(0);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockPrisma.notificationPreference.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId: { in: ["user-1"] }, quietHoursEnabled: true },
    }),
  );
});

it("enforces the displayed 22:00-08:00 window when the times were never saved", async () => {
  // 10:00 in London (inside the waking window) is 03:00 in Los Angeles.
  mockPrisma.notificationPreference.findMany.mockResolvedValue([
    {
      userId: "user-1",
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: "America/Los_Angeles",
    },
  ]);

  expect((await runAt("2026-03-09T10:00:00.000Z")).nudged).toBe(0);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockSendEmail).not.toHaveBeenCalled();
});

describe("rotation", () => {
  it("starts at an offset that moves one budget an hour and wraps", () => {
    const hour = (h: number) => new Date(h * HOUR);
    expect(rotationOffset(800, 1000, hour(7))).toBe(0);
    expect(rotationOffset(2500, 1000, hour(0))).toBe(0);
    expect(rotationOffset(2500, 1000, hour(1))).toBe(1000);
    expect(rotationOffset(2500, 1000, hour(2))).toBe(2000);
    expect(rotationOffset(2500, 1000, hour(3))).toBe(500);
  });

  it("reads consultants from the pivot to the end, then from the start", async () => {
    mockPrisma.consultantProfile.count.mockResolvedValue(2500);
    mockPrisma.consultantProfile.findFirst.mockResolvedValue({
      id: "cp-pivot",
    });
    mockPrisma.consultantProfile.findMany.mockResolvedValue([]);
    const now = "2026-03-09T10:00:00.000Z";
    await runAt(now);
    const offset = rotationOffset(2500, 1000, new Date(now));
    expect(mockPrisma.consultantProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ skip: offset, orderBy: { id: "asc" } }),
    );
    const segments = mockPrisma.consultantProfile.findMany.mock.calls.map(
      ([args]) => args.where.AND[1],
    );
    expect(segments).toEqual([
      { id: { gte: "cp-pivot" } },
      { id: { lt: "cp-pivot" } },
    ]);
  });

  it("reads every plan of each selected consultant, so a group is never split", async () => {
    // A tiny budget (one page of consultants): the two plans still go together.
    mockPrisma.consultantProfile.findMany.mockResolvedValue([{ id: "cp-1" }]);
    jest.useFakeTimers({
      now: new Date("2026-03-09T10:00:00.000Z"),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout"],
    });
    expect((await nudgeUnplacedPlanWeeks({ maxRequests: 1 })).nudged).toBe(1);
    const { where, take } = mockPrisma.subscription.findMany.mock.calls[0][0];
    expect(take).toBeUndefined();
    expect(where.AND[1]).toEqual({
      subscriptionPlan: { consultantProfileId: { in: ["cp-1"] } },
    });
    expect(mockSendEmail.mock.calls[0][0].weeks).toEqual([
      expect.objectContaining({ consulteeName: "Priya" }),
      expect.objectContaining({ consulteeName: "Ravi" }),
    ]);
  });
});

it("reminds on the week's first day, however the plan was first scheduled", async () => {
  expect((await runAt("2026-03-09T10:00:00.000Z")).nudged).toBe(1);
  expect(mockSendEmail.mock.calls[0][0].weeks).toEqual([
    expect.objectContaining({ consulteeName: "Priya" }),
    expect.objectContaining({ consulteeName: "Ravi" }),
  ]);
});

it("never sends a reminder at 08:00 that would use up the day's batch", async () => {
  // Priya's plan is on day +1 of its week; Ravi's started a day later and is
  // on day 0 (due from 09:00). Both go out together at 09:00 London.
  mockPrisma.subscription.findMany.mockResolvedValue([
    sub("sub-a", "Priya"),
    sub("sub-b", "Ravi", 1),
  ]);
  expect((await runAt("2026-03-10T08:00:00.000Z")).nudged).toBe(0);
  expect((await runAt("2026-03-10T09:00:00.000Z")).nudged).toBe(1);
  expect(mockSendEmail.mock.calls[0][0].weeks).toEqual([
    expect.objectContaining({ consulteeName: "Priya" }),
    expect.objectContaining({ consulteeName: "Ravi" }),
  ]);
});

it("reports a failed read instead of throwing into the expiry job", async () => {
  mockPrisma.notificationPreference.findMany.mockRejectedValue(
    new Error("db down"),
  );
  const result = await runAt("2026-03-09T10:00:00.000Z");
  expect(result.nudged).toBe(0);
  expect(result.errors).toEqual([
    expect.stringContaining("Week reminders stopped: Error: db down"),
  ]);
});
