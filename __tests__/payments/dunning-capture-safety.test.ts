/** @jest-environment node */

const mockFindMany = jest.fn();
const mockReadHolding = jest.fn();
const mockApplyCapture = jest.fn();
const mockOutstanding = jest.fn();
const mockNotify = jest.fn(async (..._args: unknown[]) => []);
const mockSend = jest.fn(async (..._args: unknown[]) => undefined);
const mockTx = {
  organizationInvoice: { updateMany: jest.fn(async () => ({ count: 1 })) },
  orgAuditLog: { create: jest.fn(async () => ({})) },
};
const mockTransaction = jest.fn(async (run: (tx: typeof mockTx) => unknown) =>
  run(mockTx),
);

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationInvoice: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    $transaction: (run: (tx: typeof mockTx) => unknown) => mockTransaction(run),
  },
}));
jest.mock("@/lib/feature-flags", () => ({ ENABLE_DUNNING_SUSPEND: true }));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _options: unknown, run: () => unknown) => run(),
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (run: () => unknown) => run(),
}));
jest.mock("@/lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: (...args: unknown[]) => mockReadHolding(...args),
}));
jest.mock("@/lib/payments/billing/org-invoice-settlement", () => ({
  applyOrgInvoiceCapture: (...args: unknown[]) => mockApplyCapture(...args),
  invoiceOutstandingPaise: (...args: unknown[]) => mockOutstanding(...args),
}));
jest.mock("@/lib/novu/org-workflows", () => ({
  notifyOrgInvoiceOverdue: (...args: unknown[]) => mockNotify(...args),
  rosterForOrg: jest.fn(async () => []),
  VISIBILITY_ROLES: [],
}));
jest.mock("@/lib/email", () => ({
  sendOrgInvoiceOverdueEmail: (...args: unknown[]) => mockSend(...args),
}));

import { runDunning } from "@/jobs/billing/dunning";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const candidate = {
  id: "inv-1",
  organizationId: "org-1",
  providerPaymentOrderId: "order_1",
  invoiceNumber: "INV-1",
  totalPaise: 100_000,
  displayCurrency: "INR",
  dueDate: new Date("2026-09-01T00:00:00Z"),
  organization: { name: "Org" },
};
let mockNow: number;

beforeEach(() => {
  jest.clearAllMocks();
  mockNow = Date.parse("2026-10-26T00:00:00Z");
  jest.spyOn(Date, "now").mockImplementation(() => mockNow);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockFindMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([candidate]);
  mockReadHolding.mockResolvedValue({ kind: "empty" });
  mockOutstanding.mockResolvedValue(100_000);
  mockApplyCapture.mockResolvedValue({
    kind: "PAID",
    settled: { organizationId: "org-1", invoiceNumber: "INV-1" },
  });
  mockTx.organizationInvoice.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => jest.restoreAllMocks());

it("recovers a lost capture through canonical settlement before suspension", async () => {
  mockReadHolding.mockResolvedValue({
    kind: "captured",
    paymentId: "pay_1",
    amountPaise: 100_000,
  });

  const result = await runDunning({ limit: 5 });

  expect(result).toMatchObject({ suspended: 0, failed: 0 });
  expect(mockReadHolding).toHaveBeenCalledWith("order_1", 5_000);
  expect(mockApplyCapture).toHaveBeenCalledWith(mockTx, {
    invoiceId: "inv-1",
    gatewayPaymentId: "pay_1",
    capturedPaise: 100_000,
    notesOrganizationId: "org-1",
  });
  expect(mockTx.orgAuditLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
      }),
    }),
  );
  expect(mockTx.organizationInvoice.updateMany).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
});

it("checks net debt on the transaction client and CASes the inspected order", async () => {
  const result = await runDunning({ limit: 5 });

  expect(result).toMatchObject({ suspended: 1, failed: 0 });
  expect(mockOutstanding).toHaveBeenCalledWith(mockTx, "inv-1");
  expect(mockTx.organizationInvoice.updateMany).toHaveBeenCalledWith({
    where: {
      id: "inv-1",
      status: "OVERDUE",
      dunningSuspendedAt: null,
      providerPaymentOrderId: "order_1",
    },
    data: { dunningSuspendedAt: expect.any(Date) },
  });
});

it.each(["live", "unavailable", "unapplied"])(
  "holds suspension when the provider evidence is %s",
  async (mode) => {
    if (mode === "unavailable") {
      mockReadHolding.mockRejectedValue(new Error("provider unavailable"));
    } else if (mode === "live") {
      mockReadHolding.mockResolvedValue({ kind: "live" });
    } else {
      mockReadHolding.mockResolvedValue({
        kind: "captured",
        paymentId: "pay_1",
        amountPaise: 118_000,
      });
      mockApplyCapture.mockResolvedValue({
        kind: "UNAPPLIED",
        reason: "AMOUNT_MISMATCH",
      });
    }

    const result = await runDunning({ limit: 5 });

    expect(result).toMatchObject({ suspended: 0, failed: 1 });
    expect(mockTx.organizationInvoice.updateMany).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  },
);

it("does not suspend a fully credited invoice", async () => {
  mockOutstanding.mockResolvedValue(0);

  const result = await runDunning({ limit: 5 });

  expect(result.suspended).toBe(0);
  expect(mockTx.organizationInvoice.updateMany).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
});

it("does not notify suspension when a concurrent checkout changes the order", async () => {
  mockTx.organizationInvoice.updateMany.mockResolvedValue({ count: 0 });

  const result = await runDunning({ limit: 5 });

  expect(result.suspended).toBe(0);
  expect(mockTx.orgAuditLog.create).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
});

it("stops admitting suspension reads after the bounded deadline", async () => {
  mockFindMany.mockReset();
  mockFindMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockImplementationOnce(async () => {
      mockNow += 11_000;
      return [candidate];
    });

  const result = await runDunning({ limit: 5 });

  expect(result).toMatchObject({ suspended: 0, failed: 1 });
  expect(mockReadHolding).not.toHaveBeenCalled();
  expect(mockTransaction).not.toHaveBeenCalled();
});
