/**
 * @jest-environment node
 */

/**
 * The dispute clocks.
 *
 * The business-day arithmetic matters because a deadline that lands on a
 * Sunday is not a deadline anybody can meet, and the respondent is judged
 * against it.
 */

// The sweep reads the disputes through the client and tells the platform
// through a bell and an email; both are seams here.
const mockStageBell = jest.fn<
  Promise<{ id: string }>,
  [unknown, { payload: { reference: string; dashboardUrl: string } }]
>(async () => ({ id: "outbox-1" }));
const mockDeliver = jest.fn<
  Promise<{ success: boolean; staged: boolean; data: { id: string } }>,
  unknown[]
>(async () => ({ success: true, staged: true, data: { id: "email-1" } }));

jest.mock("../../lib/prisma", () => {
  const client = {
    purchaseDispute: { findMany: jest.fn(), updateMany: jest.fn() },
    purchaseDisputeAction: { create: jest.fn() },
    user: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  client.$transaction.mockImplementation(
    async (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
  );
  return {
    __esModule: true,
    default: client,
    ALLOCATION_TX_MAX_WAIT_MS: 5000,
    ALLOCATION_TX_TIMEOUT_MS: 10000,
  };
});

jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockStageBell(...args),
}));

jest.mock("../../lib/email", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
  DEFAULT_FROM_ADDRESS: "Familiarise Support <support@mail.familiarisenow.com>",
  EMAIL_BUDGET_MS: { REQUEST: 5000, JOB: 10000, AUTH: 8000 },
}));

import {
  addBusinessDays,
  complaintDeadlines,
  respondentDueAt,
  respondentWindowPassed,
} from "../../lib/support/disputes/deadlines";
import { runDisputeSweep } from "../../lib/support/disputes/sweep";

describe("the respondent's window", () => {
  it("skips the weekend", () => {
    // Friday 2026-10-16 12:00 IST. Three business days: Mon 19, Tue 20, Wed 21.
    const friday = new Date("2026-10-16T06:30:00.000Z");
    const due = respondentDueAt(friday);
    expect(due.toISOString()).toBe("2026-10-21T06:30:00.000Z");
  });

  it("skips a weekend that falls in the middle", () => {
    // Wednesday 2026-10-14 12:00 IST. Business days: Thu 15, Fri 16, Mon 19.
    const wednesday = new Date("2026-10-14T06:30:00.000Z");
    expect(addBusinessDays(wednesday, 3).toISOString()).toBe(
      "2026-10-19T06:30:00.000Z",
    );
  });

  it("keeps the time of day", () => {
    const late = new Date("2026-10-16T12:00:00.000Z");
    const due = addBusinessDays(late, 1);
    // The same clock time three business days later, not midnight.
    expect(due.getUTCHours()).toBe(12);
  });

  it("knows when the window has passed", () => {
    const due = new Date("2026-10-21T00:00:00.000Z");
    expect(
      respondentWindowPassed(due, new Date("2026-10-20T23:59:00.000Z")),
    ).toBe(false);
    expect(
      respondentWindowPassed(due, new Date("2026-10-21T00:00:01.000Z")),
    ).toBe(true);
    // A dispute with no deadline never "passes".
    expect(
      respondentWindowPassed(null, new Date("2030-01-01T00:00:00.000Z")),
    ).toBe(false);
  });
});

describe("the statutory clocks", () => {
  it("acknowledges a complaint within 48 hours and redresses it within a month", () => {
    const from = new Date("2026-10-19T00:00:00.000Z");
    const { ackDueAt, redressalDueAt } = complaintDeadlines(from);
    expect(ackDueAt.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(redressalDueAt.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });
});

/**
 * The sweep's at-risk band.
 *
 * A claim is due a month after it is raised, and the platform has to see it
 * BEFORE it breaches — not on the day it was raised.
 */
describe("the at-risk band", () => {
  interface SweepRow {
    id: string;
    referenceNumber: string;
    status: string;
    version: number;
    createdAt: Date;
    resolvedAt: Date | null;
    respondentDueAt: Date | null;
    amountAtStakePaise: number;
    buyerUserId: string;
    supportCase: { referenceNumber: string; title: string };
  }

  interface SweepWhere {
    status?: string | { in?: string[] };
    respondentDueAt?: { lt: Date };
    createdAt?: { lt: Date };
    resolvedAt?: null;
  }

  const sweepRow = (over: Partial<SweepRow>): SweepRow => ({
    id: "d-1",
    referenceNumber: "DSP-2026-000001",
    status: "OPEN",
    version: 1,
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    resolvedAt: null,
    respondentDueAt: new Date("2026-10-23T00:00:00.000Z"),
    amountAtStakePaise: 500000,
    buyerUserId: "buyer-1",
    supportCase: { referenceNumber: "FAM-2026-000001", title: "Dispute" },
    ...over,
  });

  const matches = (row: SweepRow, where: SweepWhere): boolean => {
    if (typeof where.status === "string" && row.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status !== "string") {
      if (!(where.status.in ?? []).includes(row.status)) return false;
    }
    if (where.respondentDueAt?.lt) {
      if (
        !row.respondentDueAt ||
        !(row.respondentDueAt < where.respondentDueAt.lt)
      ) {
        return false;
      }
    }
    if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) {
      return false;
    }
    if (where.resolvedAt === null && row.resolvedAt !== null) return false;
    return true;
  };

  interface MockPrisma {
    purchaseDispute: { findMany: jest.Mock; updateMany: jest.Mock };
    purchaseDisputeAction: { create: jest.Mock };
    user: { findMany: jest.Mock };
    $transaction: jest.Mock;
  }

  const mockDb = jest.requireMock<{ default: MockPrisma }>(
    "../../lib/prisma",
  ).default;

  let disputeRows: SweepRow[] = [];

  beforeEach(() => {
    disputeRows = [];
    mockDb.purchaseDispute.findMany.mockImplementation(
      async (args: { where: SweepWhere; take?: number }) => {
        const found = disputeRows.filter((row) => matches(row, args.where));
        return args.take ? found.slice(0, args.take) : found;
      },
    );
    // The sweep's escalation wins: the respondent missed the window.
    mockDb.purchaseDispute.updateMany.mockResolvedValue({ count: 1 });
    mockDb.purchaseDisputeAction.create.mockResolvedValue({});
    mockDb.user.findMany.mockResolvedValue([
      { id: "admin-1", email: "admin@example.com" },
    ]);
  });

  it("flags a claim only as it nears its statutory deadline", async () => {
    // Raised a day ago, and raised 26 days ago (so its 30-day deadline is
    // four days out — inside the five-day band).
    disputeRows = [
      sweepRow({
        id: "d-fresh",
        referenceNumber: "DSP-2026-000001",
        createdAt: new Date("2026-10-19T00:00:00.000Z"),
      }),
      sweepRow({
        id: "d-old",
        referenceNumber: "DSP-2026-000002",
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
      }),
    ];

    const result = await runDisputeSweep({
      now: new Date("2026-10-20T00:00:00.000Z"),
    });

    expect(result.atRiskNotified).toBe(1);
    expect(mockStageBell).toHaveBeenCalledTimes(1);
    expect(mockStageBell.mock.calls[0][1].payload.reference).toBe(
      "DSP-2026-000002",
    );
  });

  it("does not flag a claim that was just raised", async () => {
    disputeRows = [
      sweepRow({
        id: "d-fresh",
        referenceNumber: "DSP-2026-000001",
        createdAt: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ];

    const result = await runDisputeSweep({
      now: new Date("2026-10-20T00:00:00.000Z"),
    });

    expect(result.atRiskNotified).toBe(0);
    expect(mockStageBell).not.toHaveBeenCalled();
  });

  it("sends the buyer to their own claim, not the admin queue", async () => {
    // The respondent missed their window, so the claim escalates and the
    // buyer is told — in a page they can open.
    disputeRows = [
      sweepRow({
        id: "d-overdue",
        referenceNumber: "DSP-2026-000003",
        createdAt: new Date("2026-10-10T00:00:00.000Z"),
        respondentDueAt: new Date("2026-10-18T00:00:00.000Z"),
      }),
    ];

    const result = await runDisputeSweep({
      now: new Date("2026-10-20T00:00:00.000Z"),
    });

    expect(result.escalated).toBe(1);
    expect(mockStageBell.mock.calls[0][1].payload.dashboardUrl).toBe(
      "/dashboard/go/client/disputes/DSP-2026-000003",
    );
  });
});
