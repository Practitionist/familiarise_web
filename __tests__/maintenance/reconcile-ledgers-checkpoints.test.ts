/** @jest-environment node */
import { runAsRegisteredPlatform } from "../fixtures/gst-registered";

const held = new Set<string>();
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: async (
    name: string,
    _options: unknown,
    run: () => Promise<unknown>,
  ) => {
    if (held.has(name)) throw new Error("lock held");
    held.add(name);
    try {
      return await run();
    } finally {
      held.delete(name);
    }
  },
}));

const models = [
  "billingAccount",
  "ledgerAccount",
  "ledgerEntry",
  "programAssignment",
  "usageLedgerEntry",
  "overageEvent",
  "organizationPayout",
  "billingSubscription",
  "program",
  "bookingUtilization",
  "ledgerTransaction",
  "consultantEarnings",
  "organizationEarnings",
  "consultantPayout",
  "payment",
  "creditNote",
  "refund",
  "organization",
  "referralCredit",
  "organizationInvoice",
];
const reads = Object.fromEntries(
  models.map((name) => [
    name,
    {
      findMany: jest.fn(async (_args: unknown): Promise<unknown[]> => []),
      groupBy: jest.fn(async (_args: unknown): Promise<unknown[]> => []),
      aggregate: jest.fn(async (_args: unknown) => ({
        _sum: { remainingAmount: 0 },
      })),
    },
  ]),
);
const snapshot = { ...reads, $executeRaw: jest.fn(async () => 0) };
const forbiddenGlobalReads = Object.fromEntries(
  models.map((name) => [
    name,
    {
      findMany: jest.fn(() => {
        throw new Error(`global read: ${name}`);
      }),
      groupBy: jest.fn(() => {
        throw new Error(`global read: ${name}`);
      }),
    },
  ]),
);
type StoredReport = {
  id: string;
  runAt: Date;
  scope: string;
  ok: boolean;
  durationMs: number;
  summary: unknown;
  findings: unknown;
};
let stored: StoredReport | null = null;
const db = {
  ...forbiddenGlobalReads,
  ledgerReconciliationReport: {
    findFirst: jest.fn(async () => stored),
    create: jest.fn(
      async ({ data }: { data: Omit<StoredReport, "id" | "runAt"> }) => {
        stored = { ...data, id: "report-1", runAt: new Date() };
        return stored;
      },
    ),
    update: jest.fn(async ({ data }: { data: Partial<StoredReport> }) => {
      if (!stored) throw new Error("missing report");
      stored = { ...stored, ...data };
      return stored;
    }),
  },
  $transaction: jest.fn(
    async (run: (tx: typeof snapshot) => Promise<unknown>) => run(snapshot),
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { runReconcileLedgers } from "../../scripts/reconcile/reconcile-ledgers";

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-22T03:55:00Z"));
  jest.clearAllMocks();
  held.clear();
  stored = null;
  db.$transaction.mockImplementation(async (run) => run(snapshot));
  for (const delegate of Object.values(reads)) {
    delegate.findMany.mockImplementation(async () => []);
    delegate.groupBy.mockImplementation(async () => []);
  }
});
afterEach(() => jest.useRealTimers());

test("resumes all missing-journal payment pages and only completes after every comparison", async () => {
  const ids = Array.from(
    { length: 105 },
    (_, index) => `payment-${String(index).padStart(3, "0")}`,
  );
  reads.consultantEarnings.groupBy.mockImplementation(async (args: unknown) => {
    const { _sum, where } = querySchema.parse(args);
    if (_sum) return [];
    jest.advanceTimersByTime(7_000);
    return ids
      .filter((id) => !where?.paymentId?.gt || id > where.paymentId.gt)
      .slice(0, 100)
      .map((paymentId) => ({ paymentId }));
  });
  const first = await runReconcileLedgers({ scope: "full" });
  expect(first.summary).toMatchObject({
    status: "RUNNING",
    nextStep: 7,
    cursor: "payment-099",
  });
  expect(first.findings).toHaveLength(100);
  const second = await runReconcileLedgers({ scope: "full" });
  expect(second.id).toBe(first.id);
  expect(second.summary).toMatchObject({ status: "RUNNING", nextStep: 8 });
  expect(second.summary.cursor).toBeUndefined();
  expect(second.findings).toHaveLength(105);
  const final = await runReconcileLedgers({ scope: "full" });
  expect(final.summary).toMatchObject({
    status: "COMPLETED",
    earningsPaymentsWithoutBookingTxn: 105,
  });
  expect(new Set(final.findings.map((finding) => finding.paymentId)).size).toBe(
    105,
  );
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
  expect(snapshot.$executeRaw).toHaveBeenCalled();
});

import { z } from "zod";
import { LEDGER_FINDINGS_BASELINE } from "../../scripts/reconcile/ledger-findings-baseline";
const querySchema = z.object({
  _sum: z.unknown().optional(),
  where: z
    .object({ paymentId: z.object({ gt: z.string() }).optional() })
    .optional(),
});

test("failed comparisons preserve their cursor and retry without duplicating completed findings", async () => {
  reads.programAssignment.findMany.mockRejectedValueOnce(
    new Error("interrupted comparison"),
  );
  await expect(runReconcileLedgers({ scope: "full" })).rejects.toThrow(
    "interrupted comparison",
  );
  expect(stored?.summary).toMatchObject({
    status: "FAILED",
    nextStep: 1,
    error: "interrupted comparison",
  });
  const report = await runReconcileLedgers({ scope: "full" });
  expect(report.summary.status).toBe("COMPLETED");
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("overage integrity honors the bounded page size and continues its historical tail", async () => {
  const ids = Array.from(
    { length: 105 },
    (_, index) => `overage-${String(index).padStart(3, "0")}`,
  );
  const overageQuerySchema = z.object({
    take: z.number().optional(),
    where: z
      .object({
        OR: z.array(z.unknown()).optional(),
        id: z.object({ gt: z.string() }).optional(),
      })
      .passthrough(),
  });
  reads.overageEvent.findMany.mockImplementation(async (args: unknown) => {
    const query = overageQuerySchema.parse(args);
    if (!query.where.OR) return [];
    jest.advanceTimersByTime(7_000);
    return ids
      .filter((id) => !query.where.id || id > query.where.id.gt)
      .slice(0, query.take)
      .map((id) => ({
        id,
        overageBehavior: "CHARGE_MEMBER",
        chargeStatus: "CHARGED",
        paymentId: null,
        invoiceLineItemId: null,
        settledAt: null,
        marginalPaise: 100,
        programAssignment: {
          id: "assignment-1",
          program: { contract: { organizationId: "org-1" } },
        },
      }));
  });
  const first = await runReconcileLedgers({ scope: "full" });
  expect(first.summary).toMatchObject({
    status: "RUNNING",
    nextStep: 2,
    cursor: "overage-099",
  });
  expect(first.findings).toHaveLength(100);
  const second = await runReconcileLedgers({ scope: "full" });
  expect(second.findings).toHaveLength(105);
  expect(second.summary).toMatchObject({ status: "RUNNING", nextStep: 3 });
  const final = await runReconcileLedgers({ scope: "full" });
  expect(final.summary.status).toBe("COMPLETED");
  expect(final.findings).toHaveLength(105);
});

test("a failed wallet freeze retries the same page without duplicating drift evidence", async () => {
  reads.billingAccount.findMany.mockResolvedValue([
    {
      id: "account-1",
      ownerOrgId: "org-1",
      currency: "INR",
      walletBalance: 100,
    },
  ]);
  const onWalletDrift = jest
    .fn(async () => undefined)
    .mockRejectedValueOnce(new Error("freeze failed"));
  await expect(
    runReconcileLedgers({ scope: "full", onWalletDrift }),
  ).rejects.toThrow("freeze failed");
  expect(stored?.summary).toMatchObject({
    status: "FAILED",
    nextStep: 0,
    accountsChecked: 0,
  });
  const report = await runReconcileLedgers({
    scope: "full",
    onWalletDrift,
  });
  expect(report.summary).toMatchObject({
    status: "COMPLETED",
    accountsChecked: 1,
  });
  expect(report.findings).toHaveLength(1);
  expect(onWalletDrift).toHaveBeenCalledTimes(2);
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("wallet surcharge GST pages whole payments without splitting one payment's overage batches", async () => {
  reads.overageEvent.groupBy.mockImplementation(async (args: unknown) => {
    const query = z.object({ by: z.array(z.string()) }).parse(args);
    return query.by[0] === "paymentId" ? [{ paymentId: "pay-1" }] : [];
  });
  reads.overageEvent.findMany.mockImplementation(async (args: unknown) => {
    const query = z
      .object({
        take: z.number().optional(),
        where: z
          .object({
            overageBehavior: z.string().optional(),
            paymentId: z.object({ in: z.array(z.string()) }).optional(),
          })
          .passthrough(),
      })
      .parse(args);
    if (query.where.overageBehavior !== "CHARGE_ORG") return [];
    return Array.from({ length: 101 }, (_, index) => ({
      id: `event-${index}`,
      paymentId: "pay-1",
      surchargePaise: 100,
      programAssignment: {
        program: {
          contract: {
            organizationId: "org-1",
            organization: { dataResidencyRegion: "IN" },
          },
        },
      },
    })).slice(0, query.take);
  });
  reads.ledgerEntry.findMany.mockImplementation(async (args: unknown) => {
    const query = z
      .object({
        where: z
          .object({ account: z.object({ kind: z.string() }).optional() })
          .passthrough(),
      })
      .parse(args);
    return query.where.account?.kind === "GST_PAYABLE"
      ? [
          {
            direction: "CREDIT",
            amountPaise: 1800,
            transaction: { paymentId: "pay-1" },
          },
        ]
      : [];
  });
  reads.payment.findMany.mockResolvedValue([{ id: "pay-1", taxAmount: 1800 }]);
  const report = await runReconcileLedgers({ scope: "full" });
  expect(report.summary.status).toBe("COMPLETED");
  expect(report.findings).toEqual([
    expect.objectContaining({
      kind: "ORG_INVOICE_GST_MISMATCH",
      paymentId: "pay-1",
      expectedPaise: 1818,
      actualPaise: 1800,
    }),
  ]);
});

test("manual and scheduled callers share one audit lease", async () => {
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  reads.billingAccount.findMany.mockImplementationOnce(async () => {
    await paused;
    return [];
  });
  const active = runReconcileLedgers({
    scope: "full",
    triggeredById: "admin-1",
  });
  await expect(runReconcileLedgers({ scope: "full" })).rejects.toThrow(
    "lock held",
  );
  release?.();
  await active;
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("a completed daily slice does not restart the full audit", async () => {
  const completed = await runReconcileLedgers({ scope: "full" });
  const comparisons = db.$transaction.mock.calls.length;
  const reused = await runReconcileLedgers({ scope: "full" });
  expect(reused.id).toBe(completed.id);
  expect(completed.reused).toBeUndefined();
  expect(reused.reused).toBe(true);
  expect(reused.summary.status).toBe("COMPLETED");
  expect(db.$transaction).toHaveBeenCalledTimes(comparisons);
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("a concurrent booking cannot mix cached counters with a later usage snapshot", async () => {
  let liveCounter = 0;
  db.$transaction.mockImplementation(async (run) => {
    const counterAtSnapshotStart = liveCounter;
    const frozenSnapshot = {
      ...snapshot,
      programAssignment: {
        ...reads.programAssignment,
        findMany: jest.fn(async () => {
          liveCounter = 1;
          return [
            {
              id: "assignment-1",
              engagementsUsed: counterAtSnapshotStart,
              consumedPaise: 0,
              overageCount: 0,
              program: {
                type: "LICENSED_SEAT",
                contract: { organizationId: "org-1" },
              },
            },
          ];
        }),
      },
      usageLedgerEntry: {
        ...reads.usageLedgerEntry,
        groupBy: jest.fn(async () => [
          {
            programAssignmentId: "assignment-1",
            _sum: {
              engagementsConsumed: counterAtSnapshotStart,
              priceAtBookingPaise: 0,
            },
          },
        ]),
      },
    };
    return run(frozenSnapshot);
  });
  const report = await runReconcileLedgers({ scope: "full" });
  expect(liveCounter).toBe(1);
  expect(report.findings).toEqual([]);
  expect(db.$transaction).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ isolationLevel: "RepeatableRead" }),
  );
});

test("records an interrupted comparison and resumes its checkpoint after the calendar day changes", async () => {
  reads.programAssignment.findMany.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(7_000);
    return [];
  });
  const first = await runReconcileLedgers({ scope: "full" });
  expect(first.summary.status).toBe("RUNNING");
  stored = { ...first, summary: { ...first.summary, executing: true } };
  jest.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const resumed = await runReconcileLedgers({ scope: "full" });
  expect(resumed.id).toBe(first.id);
  expect(resumed.summary).toMatchObject({
    status: "COMPLETED",
    interruptions: 1,
  });
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("a manual org audit stops at the slice budget and resumes its checkpoint", async () => {
  reads.billingAccount.findMany.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(7_000);
    return [];
  });
  const first = await runReconcileLedgers({
    scope: "org:org-1",
    organizationId: "org-1",
    triggeredById: "admin-1",
  });
  expect(first.summary).toMatchObject({ status: "RUNNING", nextStep: 1 });
  const final = await runReconcileLedgers({
    scope: "org:org-1",
    organizationId: "org-1",
    triggeredById: "admin-1",
  });
  expect(final.id).toBe(first.id);
  expect(final.summary.status).toBe("COMPLETED");
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(1);
});

test("an authenticated manual request starts a fresh audit after today's completed verdict", async () => {
  await runReconcileLedgers({ scope: "full" });
  await runReconcileLedgers({ scope: "full", triggeredById: "admin-1" });
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(2);
});

test("an authenticated manual request restarts a failed audit while a scheduled run resumes it", async () => {
  reads.programAssignment.findMany.mockRejectedValueOnce(
    new Error("deterministic failure"),
  );
  await expect(runReconcileLedgers({ scope: "full" })).rejects.toThrow(
    "deterministic failure",
  );
  const failedId = stored?.id;
  expect(stored?.summary).toMatchObject({ status: "FAILED", nextStep: 1 });
  db.ledgerReconciliationReport.create.mockImplementationOnce(
    async ({ data }: { data: Omit<StoredReport, "id" | "runAt"> }) => {
      stored = { ...data, id: "report-2", runAt: new Date() };
      return stored;
    },
  );
  const fresh = await runReconcileLedgers({
    scope: "full",
    triggeredById: "admin-1",
  });
  expect(fresh.id).not.toBe(failedId);
  expect(fresh.summary.status).toBe("COMPLETED");
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(2);
});

test("a checkpoint whose step name no longer matches its index is not resumed", async () => {
  await runReconcileLedgers({ scope: "full" });
  stored = {
    ...stored!,
    runAt: new Date("2026-10-21T03:55:00Z"),
    summary: {
      ...(stored!.summary as object),
      status: "RUNNING",
      nextStep: 7,
      stepName: "walletBalance",
      calls: 1,
      executing: false,
    },
  };
  const report = await runReconcileLedgers({ scope: "full" });
  expect(db.ledgerReconciliationReport.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        summary: expect.objectContaining({
          status: "FAILED",
          error: "Interrupted audit had no resumable checkpoint",
        }),
      }),
    }),
  );
  expect(db.ledgerReconciliationReport.create).toHaveBeenCalledTimes(2);
  expect(report.summary.status).toBe("COMPLETED");
});

test("an exception expiring during a multi-day audit cannot excuse its final verdict", async () => {
  const previous = [...LEDGER_FINDINGS_BASELINE];
  LEDGER_FINDINGS_BASELINE.splice(0, LEDGER_FINDINGS_BASELINE.length, {
    kind: "WALLET_BALANCE_DRIFT",
    organizationId: "org-1",
    billingAccountId: "account-1",
    deltaPaise: 100,
    owner: "test-owner",
    reason: "Temporary exception",
    expires: "2026-10-22",
  });
  try {
    reads.billingAccount.findMany.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(7_000);
      return [
        {
          id: "account-1",
          ownerOrgId: "org-1",
          currency: "INR",
          walletBalance: 100,
        },
      ];
    });
    const first = await runReconcileLedgers({ scope: "full" });
    expect(first.summary).toMatchObject({
      status: "RUNNING",
      baselinedCount: 1,
    });
    jest.setSystemTime(new Date("2026-10-24T03:55:00Z"));
    const final = await runReconcileLedgers({ scope: "full" });
    expect(final.summary).toMatchObject({
      status: "COMPLETED",
      baselinedCount: 0,
      unbaselinedCount: 1,
      baselineExpiredCount: 1,
    });
    expect(final.ok).toBe(false);
  } finally {
    LEDGER_FINDINGS_BASELINE.splice(
      0,
      LEDGER_FINDINGS_BASELINE.length,
      ...previous,
    );
  }
});

// Overage surcharges carry GST only for a GST-registered platform.
runAsRegisteredPlatform();
