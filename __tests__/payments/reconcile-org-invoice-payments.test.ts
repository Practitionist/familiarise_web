/**
 * @jest-environment node
 */

const mockFindMany = jest.fn();
const mockTransaction = jest.fn();
const mockReadHolding = jest.fn();
const mockApplyCapture = jest.fn();
const mockAttemptNotices = jest.fn();
const mockReadCheckpoint = jest.fn();
const mockReport = jest.fn();
const mockStandingFinding = jest.fn(
  async (args: { ids: string[] }, report: () => void) => {
    if (args.ids.length === 0) return false;
    report();
    return true;
  },
);
const mockWithCronLock = jest.fn(
  async (_name: string, _options: unknown, run: () => Promise<unknown>) =>
    run(),
);
const mockTx = { orgAuditLog: { create: jest.fn() } };

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationInvoice: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
  readJobCheckpoint: (...args: unknown[]) => mockReadCheckpoint(...args),
  withCronLock: (name: string, options: unknown, run: () => Promise<unknown>) =>
    mockWithCronLock(name, options, run),
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (run: () => Promise<unknown>) => run(),
}));
jest.mock("@/lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: (...args: unknown[]) => mockReadHolding(...args),
}));
jest.mock("@/lib/payments/billing/org-invoice-settlement", () => ({
  applyOrgInvoiceCapture: (...args: unknown[]) => mockApplyCapture(...args),
  attemptSettledInvoiceNotices: (...args: unknown[]) =>
    mockAttemptNotices(...args),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/observability/standing-finding", () => ({
  reportStandingFinding: (args: { ids: string[] }, report: () => void) =>
    mockStandingFinding(args, report),
}));

import { reconcileOrgInvoicePayments } from "@/lib/payments/billing/reconcile-invoice-payments";

const invoice = (id: string) => ({
  id,
  organizationId: "org-1",
  providerPaymentOrderId: `order_${id}`,
});

function rowsAfter(afterId: string | undefined, take: number) {
  const all = [invoice("a"), invoice("b"), invoice("c")];
  return all.filter((row) => !afterId || row.id > afterId).slice(0, take);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadCheckpoint.mockResolvedValue(null);
  mockTransaction.mockImplementation((run: (tx: typeof mockTx) => unknown) =>
    run(mockTx),
  );
  mockFindMany.mockImplementation(
    ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
      rowsAfter(where.id?.gt, take),
  );
});

describe("reconcileOrgInvoicePayments", () => {
  it("passes a captured INR payment through canonical settlement and leaves staged notices to relays", async () => {
    mockReadHolding.mockResolvedValue({
      kind: "captured",
      paymentId: "pay_a",
      amountPaise: 100_000,
    });
    const settled = {
      organizationId: "org-1",
      invoiceNumber: "N",
      bells: [],
      emails: [],
    };
    mockApplyCapture.mockResolvedValue({ kind: "PAID", settled });

    const result = await reconcileOrgInvoicePayments({ limit: 1 });

    expect(result).toMatchObject({
      success: true,
      scanned: 1,
      captured: 1,
      paid: 1,
      checkpoint: "a",
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockApplyCapture).toHaveBeenCalledWith(mockTx, {
      invoiceId: "a",
      gatewayPaymentId: "pay_a",
      capturedPaise: 100_000,
      notesOrganizationId: "org-1",
    });
    expect(mockReadHolding).toHaveBeenCalledWith("order_a", 5_000);
    expect(mockAttemptNotices).not.toHaveBeenCalled();
  });

  it.each([
    ["live", { kind: "live" }],
    ["empty", { kind: "empty" }],
  ])(
    "leaves a %s order unsettled while rotating its checkpoint",
    async (_name, holding) => {
      mockFindMany.mockResolvedValueOnce([invoice("b")]);
      mockReadCheckpoint.mockResolvedValue("a");
      mockReadHolding.mockResolvedValue(holding);

      const result = await reconcileOrgInvoicePayments({ limit: 1 });

      expect(result).toMatchObject({
        success: true,
        scanned: 1,
        checkpoint: "b",
      });
      expect(result.live + result.empty).toBe(1);
      expect(mockReadHolding).toHaveBeenCalledWith("order_b", 5_000);
      expect(mockApplyCapture).not.toHaveBeenCalled();
    },
  );

  it("rotates past a failing head row and reaches it again after wrapping", async () => {
    const twoRows = [invoice("a"), invoice("b")];
    mockFindMany.mockImplementation(
      ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
        twoRows
          .filter((row) => !where.id?.gt || row.id > where.id.gt)
          .slice(0, take),
    );
    mockReadHolding
      .mockRejectedValueOnce(new Error("temporary Razorpay read failure"))
      .mockResolvedValueOnce({ kind: "live" })
      .mockRejectedValueOnce(new Error("temporary Razorpay read failure"));

    const first = await reconcileOrgInvoicePayments({ limit: 1 });
    expect(first).toMatchObject({ success: false, failed: 1, checkpoint: "a" });

    mockReadCheckpoint.mockResolvedValue("a");
    const second = await reconcileOrgInvoicePayments({ limit: 1 });
    expect(second).toMatchObject({ success: true, live: 1, checkpoint: "b" });

    mockReadCheckpoint.mockResolvedValue("b");
    const third = await reconcileOrgInvoicePayments({ limit: 1 });
    const lastQuery = mockFindMany.mock.calls.at(-1)?.[0] as {
      where: Record<string, unknown>;
    };
    expect(lastQuery.where).not.toHaveProperty("id");
    expect(third).toMatchObject({ success: false, failed: 1, checkpoint: "a" });
    expect(mockReport).toHaveBeenCalledTimes(2);
  });

  it("records captured liability for operator review without retrying a second charge", async () => {
    mockFindMany.mockResolvedValueOnce([invoice("a")]);
    mockReadHolding.mockResolvedValue({
      kind: "captured",
      paymentId: "pay_mismatch",
      amountPaise: 50_000,
    });
    mockApplyCapture.mockResolvedValue({
      kind: "UNAPPLIED",
      reason: "AMOUNT_MISMATCH",
    });

    const result = await reconcileOrgInvoicePayments({ limit: 1 });

    expect(result).toMatchObject({
      success: true,
      captured: 1,
      unapplied: 1,
      checkpoint: "a",
    });
    expect(result.errors[0]).toContain("AMOUNT_MISMATCH");
    expect(mockAttemptNotices).not.toHaveBeenCalled();
    expect(mockStandingFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-org-invoice-payments",
        ids: ["a"],
      }),
      expect.any(Function),
    );
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it("does not start a gateway read after the admission deadline", async () => {
    mockFindMany.mockResolvedValueOnce([invoice("a")]);
    const priorStartedAt = Date.now() - 20_000;

    const result = await reconcileOrgInvoicePayments({
      limit: 1,
      startedAt: priorStartedAt,
    });

    expect(result).toMatchObject({
      success: false,
      scanned: 0,
      checkpoint: null,
    });
    expect(mockReadHolding).not.toHaveBeenCalled();
  });

  it("does not call an empty cohort a stalled worker after the deadline", async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await reconcileOrgInvoicePayments({
      startedAt: Date.now() - 20_000,
    });
    expect(result).toMatchObject({ success: true, scanned: 0, errors: [] });
    expect(mockReadHolding).not.toHaveBeenCalled();
  });

  it("accepts an already-applied capture without duplicating the paid audit or notices", async () => {
    mockFindMany.mockResolvedValueOnce([invoice("a")]);
    mockReadHolding.mockResolvedValue({
      kind: "captured",
      paymentId: "pay_a",
      amountPaise: 100_000,
    });
    mockApplyCapture.mockResolvedValue({ kind: "ALREADY_APPLIED" });
    const result = await reconcileOrgInvoicePayments();
    expect(result).toMatchObject({
      success: true,
      captured: 1,
      paid: 0,
      checkpoint: "a",
    });
    expect(mockTx.orgAuditLog.create).not.toHaveBeenCalled();
    expect(mockAttemptNotices).not.toHaveBeenCalled();
  });
});
