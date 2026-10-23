/** @jest-environment node */
const mockReleaseEarnings = jest.fn(
  async (_db: unknown, _side: string, ids: string[]) => ({
    released: ids,
    restored: new Map(),
  }),
);
const mockReportSentryError = jest.fn();
const mockMoneyDoorsRefusal = jest.fn();
jest.mock("../../lib/support/case-service", () => ({
  ...jest.requireActual("../../lib/support/case-service"),
  moneyDoorsRefusal: () => mockMoneyDoorsRefusal(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    async (_job: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../../lib/support/problem-cascade", () => ({
  cascadeResolvedProblems: jest.fn(async () => ({
    cascaded: 0,
    heldOpen: [],
    bells: [],
    emails: [],
  })),
}));
jest.mock("../../lib/support/evidence-retention", () => ({
  purgeExpiredSupportEvidence: jest.fn(async () => ({
    casesPurged: 0,
    filesDeleted: 0,
  })),
}));
jest.mock("../../lib/support/chat-sweep", () => ({
  sweepSupportChatAccess: jest.fn(async () => ({
    ended: 0,
    joined: 0,
    left: 0,
    notices: 0,
  })),
}));
jest.mock("../../lib/payments/payouts/earnings-holds", () => ({
  ...jest.requireActual("../../lib/payments/payouts/earnings-holds"),
  releaseEarningsHolds: (db: unknown, side: string, ids: string[]) =>
    mockReleaseEarnings(db, side, ids),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email", () => ({
  deliver: jest.fn(async () => ({ success: true })),
  DEFAULT_FROM_ADDRESS: "support@example.test",
  EMAIL_BUDGET_MS: { JOB: 1000 },
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: jest.fn(async () => null),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: jest.fn(async () => true),
}));
jest.mock("../../lib/prisma", () => {
  const tx = {
    supportCase: { updateMany: jest.fn() },
    supportCaseEvent: { findMany: jest.fn(), create: jest.fn() },
    supportCaseChatAccess: { findMany: jest.fn(), updateMany: jest.fn() },
    earningsHold: { findMany: jest.fn() },
    opsActionLog: { create: jest.fn() },
    supportFinancialRecommendation: { findFirst: jest.fn() },
  };
  const db = {
    supportCase: { findMany: jest.fn() },
    dispute: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    notificationOutbox: { findMany: jest.fn(async () => []) },
    failedEmail: { findMany: jest.fn(async () => []) },
    moderationReport: { findMany: jest.fn(async () => []) },
    supportCaseEvidenceRequest: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});

import prisma from "../../lib/prisma";
import { runSupportSlaSweep } from "../../lib/support/sla-sweep";

const db = prisma as unknown as {
  supportCase: { findMany: jest.Mock };
  tx: {
    supportCase: { updateMany: jest.Mock };
    supportCaseEvent: { findMany: jest.Mock; create: jest.Mock };
    supportCaseChatAccess: { findMany: jest.Mock; updateMany: jest.Mock };
    earningsHold: { findMany: jest.Mock };
    opsActionLog: { create: jest.Mock };
    supportFinancialRecommendation: { findFirst: jest.Mock };
  };
};
const now = new Date("2026-10-22T00:00:00Z");
const holdApplied = {
  id: "hold-event",
  caseId: "case",
  kind: "HOLD_APPLIED",
  toValue: "payment",
  note: "Disputed session",
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findMany.mockImplementation(
    async (args: { where: { status?: unknown } }) =>
      args.where.status === "RESOLVED" ? [{ id: "case" }] : [],
  );
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.tx.supportCaseEvent.findMany.mockResolvedValue([holdApplied]);
  db.tx.supportCaseEvent.create.mockResolvedValue({});
  db.tx.earningsHold.findMany.mockResolvedValue([
    { consultantEarningsId: "ce1", organizationEarningsId: null },
  ]);
  db.tx.supportCaseChatAccess.findMany.mockResolvedValue([
    { id: "g1", kind: "READ", streamJoinedAt: null, streamLeftAt: null },
  ]);
  db.tx.supportCaseChatAccess.updateMany.mockResolvedValue({ count: 1 });
  db.tx.opsActionLog.create.mockResolvedValue({ id: "log" });
  db.tx.supportFinancialRecommendation.findFirst.mockResolvedValue(null);
  mockMoneyDoorsRefusal.mockResolvedValue(null);
});

const eventsOfKind = (kind: string) =>
  db.tx.supportCaseEvent.create.mock.calls
    .map(([arg]) => arg.data)
    .filter((data: { kind: string }) => data.kind === kind);

it("releases the auto-closed case's payout holds as the system actor and ends its chat grants", async () => {
  const result = await runSupportSlaSweep({ now, limit: 20 });

  expect(result.success).toBe(true);
  expect(mockReleaseEarnings).toHaveBeenCalledWith(db.tx, "consultant", [
    "ce1",
  ]);
  expect(eventsOfKind("HOLD_RELEASED")).toEqual([
    expect.objectContaining({
      caseId: "case",
      actorId: null,
      fromValue: "hold-event",
      toValue: "payment",
      note: "Released when the case was auto-closed",
    }),
  ]);
  expect(db.tx.opsActionLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: null,
        actorRole: "SYSTEM",
        action: "support.case.release-holds",
        targetKind: "SupportCase",
        targetId: "case",
        reason: "Released when the case was auto-closed",
        after: {
          caseId: "case",
          status: "CLOSED",
          holds: [{ holdId: "hold-event", paymentId: "payment" }],
        },
      }),
    }),
  );
  expect(db.tx.supportCaseChatAccess.updateMany).toHaveBeenCalledWith({
    where: { id: "g1", endedAt: null },
    data: { endedAt: now, endedById: null, endReason: "CASE_RESOLVED" },
  });
  expect(eventsOfKind("CHAT_ACCESS_ENDED")).toHaveLength(1);
});

it("releases nothing when another writer moved the case first", async () => {
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 0 });

  await runSupportSlaSweep({ now, limit: 20 });

  expect(mockReleaseEarnings).not.toHaveBeenCalled();
  expect(db.tx.opsActionLog.create).not.toHaveBeenCalled();
  expect(db.tx.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
});

it("writes no audit row when the case holds nothing", async () => {
  db.tx.supportCaseEvent.findMany.mockResolvedValue([]);

  await runSupportSlaSweep({ now, limit: 20 });

  expect(eventsOfKind("AUTO_CLOSED")).toHaveLength(1);
  expect(eventsOfKind("HOLD_RELEASED")).toHaveLength(0);
  expect(db.tx.opsActionLog.create).not.toHaveBeenCalled();
});

it("folds a failed release into the run's errors instead of a per-row Sentry capture", async () => {
  db.supportCase.findMany.mockImplementation(
    async (args: { where: { status?: unknown } }) =>
      args.where.status === "RESOLVED" ? [{ id: "a" }, { id: "b" }] : [],
  );
  db.tx.opsActionLog.create.mockRejectedValue(new Error("log write failed"));

  const result = await runSupportSlaSweep({ now, limit: 20 });

  expect(result.success).toBe(false);
  expect(result.errors).toEqual([
    "auto-close case a: log write failed",
    "auto-close case b: log write failed",
  ]);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
});

describe("a case holding payouts", () => {
  it("auto-closes and releases when no recommendation is open and the money doors are open", async () => {
    const result = await runSupportSlaSweep({ now, limit: 20 });

    expect(result.autoClosedCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(db.tx.supportFinancialRecommendation.findFirst).toHaveBeenCalledWith(
      {
        where: { caseId: "case", decidedAt: null, voidedAt: null },
        select: { id: true },
      },
    );
    expect(mockMoneyDoorsRefusal).toHaveBeenCalledTimes(1);
    expect(eventsOfKind("AUTO_CLOSED")).toHaveLength(1);
    expect(mockReleaseEarnings).toHaveBeenCalled();
  });

  it("stays RESOLVED and writes nothing while a refund recommendation is undecided", async () => {
    db.tx.supportFinancialRecommendation.findFirst.mockResolvedValue({
      id: "rec-1",
    });

    const result = await runSupportSlaSweep({ now, limit: 20 });

    expect(result.autoClosedCount).toBe(0);
    expect(result.errors).toEqual([
      "auto-close case case: left RESOLVED (RECOMMENDATION_OPEN)",
    ]);
    expect(db.tx.supportCase.updateMany).not.toHaveBeenCalled();
    expect(db.tx.supportCaseEvent.create).not.toHaveBeenCalled();
    expect(mockReleaseEarnings).not.toHaveBeenCalled();
    expect(db.tx.opsActionLog.create).not.toHaveBeenCalled();
    expect(db.tx.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
    expect(mockMoneyDoorsRefusal).not.toHaveBeenCalled();
  });

  it("stays RESOLVED and writes nothing while the money doors are closed, reading the gate once per run", async () => {
    db.supportCase.findMany.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status === "RESOLVED" ? [{ id: "a" }, { id: "b" }] : [],
    );
    mockMoneyDoorsRefusal.mockResolvedValue({
      ok: false,
      status: 503,
      code: "MAINTENANCE",
      error: "Money actions are paused.",
    });

    const result = await runSupportSlaSweep({ now, limit: 20 });

    expect(result.autoClosedCount).toBe(0);
    expect(result.errors).toEqual([
      "auto-close case a: left RESOLVED (MAINTENANCE)",
      "auto-close case b: left RESOLVED (MAINTENANCE)",
    ]);
    expect(mockMoneyDoorsRefusal).toHaveBeenCalledTimes(1);
    expect(db.tx.supportCase.updateMany).not.toHaveBeenCalled();
    expect(db.tx.supportCaseEvent.create).not.toHaveBeenCalled();
    expect(mockReleaseEarnings).not.toHaveBeenCalled();
    expect(db.tx.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
  });

  it("does not consult the gates for a case that holds nothing", async () => {
    db.tx.supportCaseEvent.findMany.mockResolvedValue([]);
    mockMoneyDoorsRefusal.mockResolvedValue({
      ok: false,
      status: 503,
      code: "MAINTENANCE",
      error: "Money actions are paused.",
    });

    const result = await runSupportSlaSweep({ now, limit: 20 });

    expect(result.autoClosedCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(
      db.tx.supportFinancialRecommendation.findFirst,
    ).not.toHaveBeenCalled();
    expect(mockMoneyDoorsRefusal).not.toHaveBeenCalled();
  });
});
