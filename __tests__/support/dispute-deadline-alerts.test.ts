/** @jest-environment node */
const mockStageBell = jest.fn<Promise<null>, unknown[]>(async () => null);
const mockReportSentryMessage = jest.fn<void, unknown[]>();
const mockReportStandingFinding = jest.fn(
  async (_args: unknown, report: () => void) => {
    report();
    return true;
  },
);
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    async (_job: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockStageBell(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email", () => ({
  deliver: jest.fn(async () => ({ success: true })),
  DEFAULT_FROM_ADDRESS: "support@example.test",
  EMAIL_BUDGET_MS: { JOB: 1000 },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: (...args: unknown[]) => mockReportSentryMessage(...args),
}));
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (args: unknown, report: () => void) =>
    mockReportStandingFinding(args, report),
}));
jest.mock("../../lib/support/problem-cascade", () => ({
  cascadeResolvedProblems: jest.fn(async () => ({
    cascaded: 0,
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
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: { findMany: jest.fn(async () => []) },
    dispute: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    notificationOutbox: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
    },
    moderationReport: { findMany: jest.fn(async () => []) },
    supportCaseEvidenceRequest: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});
import { runSupportSlaSweep } from "../../lib/support/sla-sweep";
interface MockPrismaClient {
  supportCase: { findMany: jest.Mock };
  dispute: { findMany: jest.Mock };
  user: { findMany: jest.Mock };
  notificationOutbox: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
}
const mockPrisma = jest.requireMock<{ default: MockPrismaClient }>(
  "../../lib/prisma",
).default;
const mockTx = mockPrisma;
beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.notificationOutbox.findMany.mockResolvedValue([]);
});
describe("dispute deadline alerts", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const HOUR = 3_600_000;
  type DisputeRow = {
    id: string;
    disputeId: string;
    amountPaise: number;
    currency: string;
    reason: string;
    dueBy: Date;
  };
  const dispute = (id: string, hoursFromNow: number): DisputeRow => ({
    id,
    disputeId: `rzp_${id}`,
    amountPaise: 10_000,
    currency: "INR",
    reason: "fraudulent",
    dueBy: new Date(now.getTime() + hoursFromNow * HOUR),
  });

  // Applies the query's dueBy range, order and take, so a missing bound shows up as starvation.
  function seedDisputes(rows: DisputeRow[]) {
    mockPrisma.dispute.findMany.mockImplementation(
      async (args: {
        where: { dueBy: { gte?: Date; lte?: Date } };
        take: number;
      }) => {
        const { gte, lte } = args.where.dueBy;
        return rows
          .filter((r) => (!gte || r.dueBy >= gte) && (!lte || r.dueBy <= lte))
          .sort((a, b) => a.dueBy.getTime() - b.dueBy.getTime())
          .slice(0, args.take);
      },
    );
  }

  beforeEach(() => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "admin-1", email: "admin@test.com", name: "A", role: "ADMIN" },
    ]);
    mockPrisma.supportCase.findMany.mockResolvedValue([]);
    mockPrisma.notificationOutbox.findUnique.mockResolvedValue(null);
  });

  function stagedDisputeKeys(): string[] {
    return mockStageBell.mock.calls
      .map((c) => (c[1] as { dedupeKey: string }).dedupeKey)
      .filter((k) => k.startsWith("dispute-due:"));
  }

  it("stale past-due disputes do not starve one about to come due", async () => {
    seedDisputes([
      ...Array.from({ length: 25 }, (_, i) => dispute(`stale-${i}`, -48 - i)),
      dispute("soon", 10),
    ]);

    await runSupportSlaSweep({ now, limit: 20 });

    expect(stagedDisputeKeys()).toEqual(["dispute-due:soon:24"]);
  });

  it("pages once per run with every dispute due within 12 h or past due", async () => {
    seedDisputes([
      dispute("due-10h", 10),
      dispute("past-2h", -2),
      dispute("due-13h", 13),
      dispute("due-48h", 48),
    ]);

    await runSupportSlaSweep({ now, limit: 20 });

    expect(mockReportStandingFinding).toHaveBeenCalledTimes(1);
    const [args] = mockReportStandingFinding.mock.calls[0] as [
      { key: string; ids: string[] },
      () => void,
    ];
    expect(args.key).toBe("dispute-deadline:critical");
    expect([...args.ids].sort()).toEqual(["due-10h", "past-2h"]);
    expect(mockReportSentryMessage).toHaveBeenCalledTimes(1);
    expect(stagedDisputeKeys()).toHaveLength(4);
  });

  it("pairs already staged do not use up the batch, whichever admins their bell reached", async () => {
    seedDisputes([
      dispute("sent-a", 5),
      dispute("sent-b", 6),
      dispute("new-c", 40),
    ]);
    // Staged rows are found by entityRef; their transactionId depends on which admins the bell policy allowed.
    mockPrisma.notificationOutbox.findMany.mockImplementation(
      async (args: { where: { entityRef?: { in: string[] } } }) =>
        (args.where.entityRef?.in ?? [])
          .filter((ref) =>
            ["dispute-due:sent-a:24", "dispute-due:sent-b:24"].includes(ref),
          )
          .map((entityRef) => ({ entityRef })),
    );

    await runSupportSlaSweep({ now, limit: 1 });

    expect(stagedDisputeKeys()).toEqual(["dispute-due:new-c:72"]);
    expect(mockStageBell).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ entityRef: "dispute-due:new-c:72" }),
    );
  });

  it("pages every critical dispute even when the send batch is smaller", async () => {
    seedDisputes([dispute("c1", 1), dispute("c2", 2), dispute("c3", 3)]);

    await runSupportSlaSweep({ now, limit: 1 });

    const [args] = mockReportStandingFinding.mock.calls[0] as [
      { ids: string[] },
      () => void,
    ];
    expect([...args.ids].sort()).toEqual(["c1", "c2", "c3"]);
    expect(stagedDisputeKeys()).toEqual(["dispute-due:c1:24"]);
  });

  it("links the alert to the admin dispute detail page", async () => {
    seedDisputes([dispute("disp-link", 30)]);

    await runSupportSlaSweep({ now, limit: 20 });

    const call = mockStageBell.mock.calls.find(
      (c) =>
        (c[1] as { dedupeKey: string }).dedupeKey ===
        "dispute-due:disp-link:72",
    );
    expect(
      (call?.[1] as { payload: { dashboardUrl: string } }).payload.dashboardUrl,
    ).toMatch(/\/dashboard\/admin\/disputes\/disp-link$/);
  });
});
