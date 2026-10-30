/**
 * @jest-environment node
 */

/**
 * A capture that funds no booking is auto-refunded; when the gateway captured
 * less than the order, the retry must ask for what was captured (still parked),
 * never the ordered amount the gateway would refuse.
 */
const mockRefundBookingPayment = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockLedgerEntryFindMany = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    ledgerEntry: {
      findMany: (...a: unknown[]) => mockLedgerEntryFindMany(...a),
    },
    systemEvent: { findFirst: jest.fn(async () => null) },
  },
}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  RefundValidationError: class extends Error {},
  RefundGatewayError: class extends Error {},
  findDedupedRefund: async () => null,
}));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
  recordSystemEvent: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/payments/webhooks/handlers", () => ({
  releaseBlockedBookingHold: jest.fn(),
  settleAutoRefundMarker: jest.fn(),
}));
jest.mock("@/lib/trials/cancellation", () => ({
  stampTrialEarningsOnCancel: jest.fn(),
}));

import { retryAutoRefunds } from "@/scripts/payments/retry-auto-refunds";

const parked = {
  id: "pay-short",
  description: "Auto-refund pending: capture amount 90000p ≠ expected 100000p",
  appointmentId: null,
  refunds: [],
};

beforeEach(() => {
  mockRefundBookingPayment.mockReset().mockResolvedValue({
    refundId: "rf-1",
    amountRefundedPaise: 90_000,
    status: "SUCCEEDED",
  });
  // The auto-refund cohort first, then the owed and aged cohorts (empty).
  mockPaymentFindMany
    .mockReset()
    .mockResolvedValueOnce([parked])
    .mockResolvedValue([]);
  mockPaymentFindUnique.mockReset().mockResolvedValue({
    amount: 100_000,
    refunds: [],
    disputes: [],
  });
});

describe("auto-refund retry of a short capture", () => {
  it("asks for the captured paise still parked, not Payment.amount", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      { direction: "CREDIT", amountPaise: 90_000 },
    ]);

    await retryAutoRefunds();

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-short", amountPaise: 90_000 }),
    );
  });

  it("settles without a refund call when the parked capture already went back", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      { direction: "CREDIT", amountPaise: 90_000 },
      { direction: "DEBIT", amountPaise: 90_000 },
    ]);

    const result = await retryAutoRefunds();

    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(result.settled).toBe(1);
  });

  it("refunds the full balance when nothing was parked", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([]);

    await retryAutoRefunds();

    const input = mockRefundBookingPayment.mock.calls[0]?.[0] as {
      amountPaise?: number;
    };
    expect(input.amountPaise).toBeUndefined();
  });
});
