/**
 * @jest-environment node
 */

// Invariant: an un-invoiced SUCCEEDED consumer payment is minted by a bounded, rotating slice; a missing GSTIN is one config skip plus the turnover alarm.

const mockSupplier = jest.fn();
const mockMint = jest.fn();
const mockFindMany = jest.fn();
const mockCapture = jest.fn();
const mockAggregate = jest.fn();

jest.mock("@/lib/pdf/supplier", () => ({
  ...jest.requireActual("@/lib/pdf/supplier"),
  platformSupplierForJob: () => mockSupplier(),
}));
jest.mock("@/lib/payments/billing/consumer-invoice", () => ({
  ...jest.requireActual("@/lib/payments/billing/consumer-invoice"),
  mintConsumerInvoice: (_tx: unknown, args: { paymentId: string }) =>
    mockMint(args.paymentId),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockCapture(...a),
  reportSentryMessage: (...a: unknown[]) => mockCapture(...a),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      aggregate: () => mockAggregate("payment"),
    },
    paymentLeg: { aggregate: () => mockAggregate("credits") },
    refund: { aggregate: () => mockAggregate("refunds") },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

import { CONSUMER_INVOICEABLE_PAYMENT_WHERE } from "@/lib/payments/billing/consumer-invoice";
import { healConsumerInvoices } from "@/lib/payments/billing/consumer-invoice-healer";

const now = new Date("2026-10-26T01:50:00.000Z");
const ids = (...xs: string[]) => xs.map((id) => ({ id }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSupplier.mockReturnValue({ gstin: "29ABCDE1234F1Z5" });
});

it("mints nothing while unregistered and alarms once at ₹15 lakh of FY turnover", async () => {
  mockSupplier.mockReturnValue(null);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const sums = (amount: number) => (kind: string) =>
    kind === "payment"
      ? { _sum: { amount, taxAmount: 0 } }
      : kind === "credits"
        ? { _sum: { amountPaise: 6_000_000 } }
        : { _sum: { amountPaise: 8_000_000 } };

  mockAggregate.mockImplementation(sums(100_000_000));
  const quiet = await healConsumerInvoices({ limit: 25, now });
  expect(quiet.skipped).toBe("PLATFORM_GSTIN not configured");
  expect(quiet.turnover).toMatchObject({
    turnoverPaise: 98_000_000,
    alarmed: false,
  });
  expect(mockFindMany).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();

  mockAggregate.mockImplementation(sums(154_000_000));
  const loud = await healConsumerInvoices({ limit: 25, now });
  expect(loud.turnover).toMatchObject({
    turnoverPaise: 152_000_000,
    alarmed: true,
  });
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(String(mockCapture.mock.calls[0][0])).toMatch(/₹20,00,000/);
});

it("mints from the pivot, wraps around, and treats a lost mint race as done", async () => {
  mockFindMany
    .mockResolvedValueOnce(ids("p-m", "p-z"))
    .mockResolvedValueOnce(ids("p-a"));
  mockMint
    .mockResolvedValueOnce({ consumerInvoiceId: "inv-1" })
    .mockResolvedValueOnce({ consumerInvoiceId: null })
    .mockRejectedValueOnce({ code: "P2002", meta: { target: ["paymentId"] } });

  const result = await healConsumerInvoices({ limit: 3, now, pivot: "p-m" });

  expect(result).toEqual({ scanned: 3, minted: 1, declined: 1, failed: 0 });
  const [head, tail] = mockFindMany.mock.calls.map((c) => c[0]);
  expect(head.where).toMatchObject({
    ...CONSUMER_INVOICEABLE_PAYMENT_WHERE,
    paymentStatus: "SUCCEEDED",
    consumerInvoice: null,
    // A refunded supply is left to ops: an invoice alone would overstate output tax.
    refunds: { none: { status: { in: ["PENDING", "SUCCEEDED"] } } },
    id: { gte: "p-m" },
    createdAt: { gte: new Date("2026-07-28T01:50:00.000Z") },
  });
  expect(tail.where.id).toEqual({ lt: "p-m" });
  expect(tail.take).toBe(1);
  expect(mockCapture).not.toHaveBeenCalled();
});

it("reports failed mints once per run, not once per payment", async () => {
  mockFindMany.mockResolvedValueOnce(ids("p-1", "p-2"));
  mockMint.mockRejectedValue(new Error("db down"));
  const result = await healConsumerInvoices({ limit: 2, now, pivot: "p-0" });
  expect(result.failed).toBe(2);
  expect(mockCapture).toHaveBeenCalledTimes(1);
});
