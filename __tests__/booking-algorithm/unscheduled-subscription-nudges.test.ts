/**
 * @jest-environment node
 */

/**
 * #1703 — consultant nudges for a paid subscription that still has no session
 * times: the stage is the latest of day 3 / 7 / 14 the row has reached, the
 * bell is keyed per stage through the notification outbox and the email
 * through its own FailedEmail row, so a re-run repeats neither.
 */

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    appointmentOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    notificationOutbox: { findMany: jest.fn().mockResolvedValue([]) },
    failedEmail: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({
  UNANSWERED_REQUEST_REASON: "unanswered",
  notifyConsulteeRequestExpired: jest.fn(),
}));
const mockNudgeBell = jest.fn(async () => ({ success: true }));
jest.mock("../../lib/novu/service", () => ({
  notifyUnscheduledSubscriptionNudge: (...a: unknown[]) =>
    mockNudgeBell(...(a as [])),
}));
const mockNudgeEmail = jest.fn(async () => ({
  sent: 1,
  skipped: 0,
  failed: 0,
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1 },
  SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE: "SUBSCRIPTION_UNSCHEDULED_NUDGE",
  unscheduledNudgeEntityRef: (id: string, day: number) =>
    `subscription:${id}:day${day}`,
  sendUnscheduledSubscriptionNudgeEmail: (...a: unknown[]) =>
    mockNudgeEmail(...(a as [])),
}));

import prisma from "../../lib/prisma";
import { deriveTransactionId } from "../../lib/novu/outbox";
import {
  expireStaleRequests,
  nudgeStageFor,
  subscriptionNudgeDedupeKey,
} from "../../scripts/appointments/expire-stale-requests";

const DAY = 24 * 60 * 60 * 1000;
const db = prisma as unknown as {
  subscription: { findMany: jest.Mock };
  notificationOutbox: { findMany: jest.Mock };
  failedEmail: { findMany: jest.Mock };
};

function waitingSubscription(ageDays: number) {
  return {
    id: "sub_1",
    updatedAt: new Date(Date.now() - ageDays * DAY),
    requestedBy: { user: { name: "Olivia" } },
    subscriptionPlan: {
      title: "Mentorship",
      consultantProfile: { id: "cp_1", user: { id: "u_consultant" } },
    },
    appointment: { id: "apt_1", organizationId: null },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  db.notificationOutbox.findMany.mockResolvedValue([]);
  db.failedEmail.findMany.mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe("nudge stage", () => {
  it("is the latest of 3 / 7 / 14 the row has reached", () => {
    expect(nudgeStageFor(2 * DAY)).toBeNull();
    expect(nudgeStageFor(3 * DAY)).toBe(3);
    expect(nudgeStageFor(8 * DAY)).toBe(7);
    expect(nudgeStageFor(40 * DAY)).toBe(14);
  });
});

describe("nudgeUnscheduledSubscriptions", () => {
  it("sends the stage once — bell keyed through the outbox, then the email", async () => {
    // The nudge read is the one subscription cohort that pins deletedAt.
    db.subscription.findMany.mockImplementation(
      async (args: { where: { deletedAt?: null } }) =>
        args.where.deletedAt === null ? [waitingSubscription(8)] : [],
    );
    const result = await expireStaleRequests();
    expect(result.subscriptionNudgesSent).toBe(1);
    const dedupeKey = subscriptionNudgeDedupeKey("sub_1", 7);
    expect(mockNudgeBell).toHaveBeenCalledWith(
      "u_consultant",
      expect.objectContaining({
        consulteeName: "Olivia",
        planTitle: "Mentorship",
        nudgeDay: 7,
        dashboardUrl: expect.stringMatching(
          /\/dashboard\/consultant\/cp_1\/appointments\/apt_1\/timings$/,
        ),
      }),
      dedupeKey,
    );
    expect(mockNudgeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub_1", nudgeDays: 7 }),
      1,
    );

    // Each arm's staged row is its own claim: with the bell's row but no
    // email row, only the email is retried; with both, nothing is.
    db.notificationOutbox.findMany.mockResolvedValue([
      {
        transactionId: deriveTransactionId(
          "new-booking-request",
          ["u_consultant"],
          {},
          dedupeKey,
        ),
      },
    ]);
    const emailOnly = await expireStaleRequests();
    expect(emailOnly.subscriptionNudgesSent).toBe(1);
    expect(mockNudgeBell).toHaveBeenCalledTimes(1);
    expect(mockNudgeEmail).toHaveBeenCalledTimes(2);

    db.failedEmail.findMany.mockResolvedValue([
      { entityRef: "subscription:sub_1:day7" },
    ]);
    const again = await expireStaleRequests();
    expect(again.subscriptionNudgesSent).toBe(0);
    expect(mockNudgeBell).toHaveBeenCalledTimes(1);
    expect(mockNudgeEmail).toHaveBeenCalledTimes(2);
  });
});
