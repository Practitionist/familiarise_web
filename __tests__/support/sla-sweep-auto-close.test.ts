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
  HELD_OPEN_SCAN_FACTOR: 2,
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
    boundaries: 0,
    notices: 0,
  })),
}));
jest.mock("../../lib/payments/payouts/earnings-holds", () => ({
  ...jest.requireActual("../../lib/payments/payouts/earnings-holds"),
  releaseEarningsHolds: (db: unknown, side: string, ids: string[]) =>
    mockReleaseEarnings(db, side, ids),
}));
jest.mock("../../lib/support/removal-review", () => ({
  hasRemovalReviewWork: async () => false,
  sweepRemovalReviews: async () => ({ decided: 0, refundedOnDeadline: 0 }),
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
    supportCase: { findMany: jest.fn(), updateMany: jest.fn() },
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

import { runSupportSlaSweep } from "../../lib/support/sla-sweep";

type MockDb = {
  supportCase: { findMany: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
  tx: {
    supportCase: { updateMany: jest.Mock };
    supportCaseEvent: { findMany: jest.Mock; create: jest.Mock };
    supportCaseChatAccess: { findMany: jest.Mock; updateMany: jest.Mock };
    earningsHold: { findMany: jest.Mock };
    opsActionLog: { create: jest.Mock };
    supportFinancialRecommendation: { findFirst: jest.Mock };
  };
};
const db = jest.requireMock<{ default: MockDb }>("../../lib/prisma").default;
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
  db.$transaction.mockImplementation(
    (run: (tx: MockDb["tx"]) => Promise<unknown>) => run(db.tx),
  );
  jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Network denied"));
  db.supportCase.findMany.mockImplementation(
    async (args: { where: { status?: unknown } }) =>
      args.where.status === "RESOLVED" ? [{ id: "case" }] : [],
  );
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
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

afterEach(() => {
  jest.restoreAllMocks();
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
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.autoCloseHeldOpen).toBe(1);
    expect(result.autoCloseHolds).toEqual([
      { caseId: "case", reason: "RECOMMENDATION_OPEN" },
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
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.autoCloseHeldOpen).toBe(2);
    expect(result.autoCloseHolds).toEqual([
      { caseId: "a", reason: "MAINTENANCE" },
      { caseId: "b", reason: "MAINTENANCE" },
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

describe("the auto-close scan", () => {
  const resolvedScan = () =>
    (db.supportCase.findMany.mock.calls as [{ where: { status?: unknown } }][])
      .map(([args]) => args)
      .find((args) => args.where.status === "RESOLVED");

  it("scans never-attempted then oldest attempts, continuing past holds within the read cap", async () => {
    db.supportCase.findMany.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status === "RESOLVED"
          ? [{ id: "held" }, { id: "b" }, { id: "c" }]
          : [],
    );
    db.tx.supportFinancialRecommendation.findFirst.mockImplementation(
      async (args: { where: { caseId: string } }) =>
        args.where.caseId === "held" ? { id: "rec-1" } : null,
    );

    const result = await runSupportSlaSweep({ now, limit: 2 });

    expect(resolvedScan()).toMatchObject({
      orderBy: [
        { autoCloseLastAttemptAt: { sort: "asc", nulls: "first" } },
        { resolvedAt: "asc" },
        { id: "asc" },
      ],
      take: 4,
    });
    expect(result.autoClosedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.autoCloseHeldOpen).toBe(1);
    expect(
      db.tx.supportCase.updateMany.mock.calls.map(
        ([args]: [{ where: { id: string } }]) => args.where.id,
      ),
    ).toEqual(["b", "c"]);
  });

  it("stops once the run's limit of cases has closed", async () => {
    db.supportCase.findMany.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status === "RESOLVED"
          ? [{ id: "a" }, { id: "b" }, { id: "c" }]
          : [],
    );

    const result = await runSupportSlaSweep({ now, limit: 2 });

    expect(result.autoClosedCount).toBe(2);
    expect(
      db.tx.supportCase.updateMany.mock.calls.map(
        ([args]: [{ where: { id: string } }]) => args.where.id,
      ),
    ).toEqual(["a", "b"]);
  });
});

type AutoCloseRow = {
  id: string;
  status: "RESOLVED" | "CLOSED";
  resolvedAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  autoCloseLastAttemptAt: Date | null;
};

function durableAutoCloseRows(heldCount: number, tailCount: number) {
  const rows: AutoCloseRow[] = Array.from(
    { length: heldCount + tailCount },
    (_, i) => ({
      id: i < heldCount ? `held-${i}` : `tail-${i}`,
      status: "RESOLVED",
      resolvedAt: new Date(now.getTime() - (60 - i) * 86_400_000),
      updatedAt: new Date(now.getTime() - 60 * 86_400_000),
      deletedAt: null,
      autoCloseLastAttemptAt: null,
    }),
  );
  db.supportCase.findMany.mockImplementation(
    async (args: {
      where: { status?: unknown };
      orderBy?:
        { resolvedAt?: string } | Array<{ autoCloseLastAttemptAt?: unknown }>;
      take?: number;
    }) => {
      if (args.where.status !== "RESOLVED") return [];
      const fairOrder =
        Array.isArray(args.orderBy) &&
        args.orderBy.some((order) => order.autoCloseLastAttemptAt);
      return rows
        .filter((row) => row.status === "RESOLVED" && !row.deletedAt)
        .sort((a, b) => {
          const attempts = fairOrder
            ? (a.autoCloseLastAttemptAt?.getTime() ?? -Infinity) -
              (b.autoCloseLastAttemptAt?.getTime() ?? -Infinity)
            : 0;
          return (
            attempts ||
            a.resolvedAt.getTime() - b.resolvedAt.getTime() ||
            a.id.localeCompare(b.id)
          );
        })
        .slice(0, args.take);
    },
  );
  db.supportCase.updateMany.mockImplementation(
    async (query: {
      where: {
        id: string;
        status: string;
        resolvedAt: { lte: Date };
        deletedAt: null;
        autoCloseLastAttemptAt: Date | null;
        updatedAt: Date;
      };
      data: { autoCloseLastAttemptAt: Date; updatedAt: Date };
    }) => {
      const attemptedAt = query.data.autoCloseLastAttemptAt;
      const {
        id,
        status,
        resolvedAt,
        deletedAt,
        autoCloseLastAttemptAt,
        updatedAt,
      } = query.where;
      const cutoff = resolvedAt.lte;
      if (
        !(attemptedAt instanceof Date) ||
        typeof id !== "string" ||
        status !== "RESOLVED" ||
        deletedAt !== null ||
        !(updatedAt instanceof Date) ||
        query.data.updatedAt.getTime() !== updatedAt.getTime()
      ) {
        throw new Error("Unexpected auto-close polling stamp");
      }
      const row = rows.find((candidate) => candidate.id === id);
      if (
        !row ||
        row.status !== "RESOLVED" ||
        row.deletedAt ||
        !(cutoff instanceof Date) ||
        row.resolvedAt > cutoff
      ) {
        return { count: 0 };
      }
      const previousTime =
        autoCloseLastAttemptAt instanceof Date
          ? autoCloseLastAttemptAt.getTime()
          : null;
      if ((row.autoCloseLastAttemptAt?.getTime() ?? null) !== previousTime) {
        return { count: 0 };
      }
      if (row.updatedAt.getTime() !== updatedAt.getTime()) return { count: 0 };
      row.autoCloseLastAttemptAt = attemptedAt;
      row.updatedAt = query.data.updatedAt;
      return { count: 1 };
    },
  );
  db.tx.supportCase.updateMany.mockImplementation(
    async (query: { where: { id: string } }) => {
      const row = rows.find((candidate) => candidate.id === query.where.id);
      if (!row || row.status !== "RESOLVED" || row.deletedAt)
        return { count: 0 };
      row.status = "CLOSED";
      return { count: 1 };
    },
  );
  db.tx.supportFinancialRecommendation.findFirst.mockImplementation(
    async (query: { where: { caseId: string } }) =>
      query.where.caseId.startsWith("held-")
        ? { id: "open-recommendation" }
        : null,
  );
  return rows;
}

it("reports an expected auto-close hold without failing or paging the sweep", async () => {
  durableAutoCloseRows(1, 0);
  const result = await runSupportSlaSweep({ now, limit: 2 });
  expect(result.success).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.autoClosedCount).toBe(0);
  expect(result).toMatchObject({
    autoCloseHeldOpen: 1,
    autoCloseHolds: [{ caseId: "held-0", reason: "RECOMMENDATION_OPEN" }],
  });
  expect(mockReportSentryError).not.toHaveBeenCalled();
  expect(mockReleaseEarnings).not.toHaveBeenCalled();
});

it("reaches the closable tail across runs after more held cases than the read cap", async () => {
  const rows = durableAutoCloseRows(8, 2);
  const first = await runSupportSlaSweep({ now, limit: 2 });
  const second = await runSupportSlaSweep({ now, limit: 2 });
  const third = await runSupportSlaSweep({ now, limit: 2 });
  expect([
    first.autoClosedCount,
    second.autoClosedCount,
    third.autoClosedCount,
  ]).toEqual([0, 0, 2]);
  expect(
    rows
      .filter((row) => row.id.startsWith("held-"))
      .every((row) => row.status === "RESOLVED"),
  ).toBe(true);
  expect(
    rows
      .filter((row) => row.id.startsWith("tail-"))
      .every((row) => row.status === "CLOSED"),
  ).toBe(true);
});

it("keeps held reasons bounded while reporting the full held count", async () => {
  durableAutoCloseRows(24, 0);
  const result = await runSupportSlaSweep({ now, limit: 12 });
  expect(result.autoCloseHeldOpen).toBe(24);
  expect(result.autoCloseHolds).toHaveLength(10);
  expect(result.autoCloseHasMore).toBe(true);
  expect(result.success).toBe(true);
  expect(mockReportSentryError).not.toHaveBeenCalled();
});

it("rotates failed transactions using durable progress while real errors still fail and page once", async () => {
  const rows = durableAutoCloseRows(2, 1);
  db.$transaction.mockRejectedValueOnce(
    new Error("transaction interrupted after progress commit"),
  );
  const first = await runSupportSlaSweep({ now, limit: 1 });
  expect(first.success).toBe(false);
  expect(first.errors).toEqual([
    "auto-close case held-0: transaction interrupted after progress commit",
  ]);
  expect(first.autoCloseHasMore).toBe(true);
  expect(rows[0]?.autoCloseLastAttemptAt).toBeInstanceOf(Date);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  const second = await runSupportSlaSweep({ now, limit: 1 });
  expect(second.autoClosedCount).toBe(1);
  expect(second.errors).toEqual([]);
  expect(rows[2]?.status).toBe("CLOSED");
});

it("preserves resolvedAt and updatedAt when a held attempt rotates", async () => {
  const rows = durableAutoCloseRows(1, 0);
  const clocks = {
    resolvedAt: rows[0]?.resolvedAt,
    updatedAt: rows[0]?.updatedAt,
  };
  await runSupportSlaSweep({ now, limit: 1 });
  expect(rows[0]).toMatchObject(clocks);
  expect(rows[0]?.autoCloseLastAttemptAt).toBeInstanceOf(Date);
  expect(db.supportCase.updateMany).toHaveBeenCalledWith({
    where: {
      id: "held-0",
      status: "RESOLVED",
      resolvedAt: { lte: new Date(now.getTime() - 28 * 86_400_000) },
      deletedAt: null,
      autoCloseLastAttemptAt: null,
      updatedAt: rows[0]?.updatedAt,
    },
    data: {
      autoCloseLastAttemptAt: expect.any(Date),
      updatedAt: rows[0]?.updatedAt,
    },
  });
});

it("does not stamp after a concurrent business update changes updatedAt", async () => {
  const rows = durableAutoCloseRows(0, 1);
  const stamp = db.supportCase.updateMany.getMockImplementation();
  if (!stamp) throw new Error("Missing stamp mock");
  db.supportCase.updateMany.mockImplementationOnce((query) => {
    const row = rows[0];
    if (!row) throw new Error("Missing candidate");
    row.updatedAt = new Date(now.getTime() + 1);
    return stamp(query);
  });

  const result = await runSupportSlaSweep({ now, limit: 1 });

  expect(result.autoClosedCount).toBe(0);
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(rows[0]?.status).toBe("RESOLVED");
  expect(rows[0]?.autoCloseLastAttemptAt).toBeNull();
  expect(rows[0]?.updatedAt).toEqual(new Date(now.getTime() + 1));
});

it("does not enter the closing transaction after losing the progress CAS", async () => {
  const rows = durableAutoCloseRows(0, 1);
  const stamp = db.supportCase.updateMany.getMockImplementation();
  if (!stamp) throw new Error("Missing stamp mock");
  db.supportCase.updateMany.mockImplementationOnce((query) => {
    const row = rows[0];
    if (!row) throw new Error("Missing candidate");
    row.autoCloseLastAttemptAt = new Date(now);
    return stamp(query);
  });
  const result = await runSupportSlaSweep({ now, limit: 1 });
  expect(result.autoClosedCount).toBe(0);
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(mockReleaseEarnings).not.toHaveBeenCalled();
  expect(rows[0]?.status).toBe("RESOLVED");
});

it("does not close a row tombstoned between selection and progress stamping", async () => {
  const rows = durableAutoCloseRows(0, 1);
  const stamp = db.supportCase.updateMany.getMockImplementation();
  if (!stamp) throw new Error("Missing stamp mock");
  db.supportCase.updateMany.mockImplementationOnce((query) => {
    const row = rows[0];
    if (!row) throw new Error("Missing candidate");
    row.deletedAt = now;
    return stamp(query);
  });
  const result = await runSupportSlaSweep({ now, limit: 1 });
  expect(result.autoClosedCount).toBe(0);
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(rows[0]?.autoCloseLastAttemptAt).toBeNull();
});

it("does not stamp or query auto-close candidates after earlier arms consume the admission budget", async () => {
  const rows = durableAutoCloseRows(1, 1);
  const result = await runSupportSlaSweep({
    now,
    limit: 1,
    startedAt: Date.now() - 16_000,
  });
  expect(result.autoClosedCount).toBe(0);
  expect(result.autoCloseHasMore).toBe(true);
  expect(db.supportCase.updateMany).not.toHaveBeenCalled();
  expect(rows.every((row) => row.autoCloseLastAttemptAt === null)).toBe(true);
  expect(result.success).toBe(true);
});

it("stops admission after a slow attempt and leaves later rows unstamped", async () => {
  const rows = durableAutoCloseRows(2, 0);
  const clock = jest.spyOn(Date, "now").mockReturnValue(1_000);
  db.tx.supportFinancialRecommendation.findFirst.mockImplementationOnce(
    async () => {
      clock.mockReturnValue(17_000);
      return { id: "recommendation" };
    },
  );
  const result = await runSupportSlaSweep({ now, limit: 1 });
  expect(result.autoCloseHeldOpen).toBe(1);
  expect(result.autoCloseHasMore).toBe(true);
  expect(db.supportCase.updateMany).toHaveBeenCalledTimes(1);
  expect(rows[0]?.autoCloseLastAttemptAt).toBeInstanceOf(Date);
  expect(rows[1]?.autoCloseLastAttemptAt).toBeNull();
});

it("leaves selected rows unstamped once enough cases close", async () => {
  const rows = durableAutoCloseRows(0, 3);
  const result = await runSupportSlaSweep({ now, limit: 1 });
  expect(result.autoClosedCount).toBe(1);
  expect(result.autoCloseHasMore).toBe(true);
  expect(db.supportCase.updateMany).toHaveBeenCalledTimes(1);
  expect(rows[1]?.autoCloseLastAttemptAt).toBeNull();
  expect(rows[2]?.autoCloseLastAttemptAt).toBeNull();
});

it("advances the progress CAS even when two runs share the same clock millisecond", async () => {
  const rows = durableAutoCloseRows(1, 0);
  const row = rows[0];
  if (!row) throw new Error("Missing candidate");
  row.autoCloseLastAttemptAt = new Date(1_000);
  jest.spyOn(Date, "now").mockReturnValue(1_000);
  await runSupportSlaSweep({ now, limit: 1 });
  expect(row.autoCloseLastAttemptAt?.getTime()).toBe(1_001);
  await runSupportSlaSweep({ now, limit: 1 });
  expect(row.autoCloseLastAttemptAt?.getTime()).toBe(1_002);
});

it("retains unreadable maintenance state as a failure while the attempt rotates", async () => {
  const rows = durableAutoCloseRows(0, 1);
  mockMoneyDoorsRefusal.mockResolvedValue({ code: "MAINTENANCE_UNKNOWN" });
  const result = await runSupportSlaSweep({ now, limit: 1 });
  expect(result.success).toBe(false);
  expect(result.errors).toEqual([
    "auto-close case tail-0: left RESOLVED (MAINTENANCE_UNKNOWN)",
  ]);
  expect(result.autoCloseHeldOpen).toBe(0);
  expect(result.autoCloseHasMore).toBe(true);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  expect(rows[0]?.status).toBe("RESOLVED");
  expect(rows[0]?.autoCloseLastAttemptAt).toBeInstanceOf(Date);
  expect(mockReleaseEarnings).not.toHaveBeenCalled();
});
