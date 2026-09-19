/**
 * @jest-environment node
 */

/**
 * #1583 C-P0-03 / C-P0-04 — a whole-event refund clamps every internal seat
 * to its refundable balance.
 *
 * `reverseClassMulti` split the batch by each seat's GROSS amount and threw
 * when the requested total exceeded the gross sum, and its caller asked for
 * that gross sum every time. A seat that had already been refunded on its own
 * (a removed attendee, an admin refund) therefore either made the whole batch
 * throw or, worse, got a second cascade. Now the share base and the headroom
 * cap are the refundable balance read in the same transaction, a seat with no
 * balance left gets no Refund row, and a batch with nothing left is reported
 * as `alreadyRefunded` rather than reversed again.
 *
 * The reversal engine runs for real here; only the deep cascade and the
 * database are stubbed, so the arithmetic under test is the engine's own.
 */

const mockPaymentFindMany = jest.fn();
const mockTxPaymentFindMany = jest.fn();
const mockRefundCreate = jest.fn();
const mockRefundUpdate = jest.fn();
const mockApplyRefundCascade = jest.fn();
const mockRefundPayment = jest.fn();
const mockRefundBookingPayment = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        payment: { findMany: (...a: unknown[]) => mockTxPaymentFindMany(...a) },
        refund: {
          create: (...a: unknown[]) => mockRefundCreate(...a),
          update: (...a: unknown[]) => mockRefundUpdate(...a),
        },
      }),
  },
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: (...a: unknown[]) => mockApplyRefundCascade(...a),
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  RefundValidationError: class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  },
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  isInternalFundedIntent: (i: string) => i.startsWith("org_"),
  isFreeCreditIntent: (i: string) => i.startsWith("free_"),
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({ notifyRefundProcessed: jest.fn() }));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  sendRefundProcessedEmail: jest.fn(),
}));

import { refundWholeEventPayments } from "../../lib/payments/operations/event-refunds";

/** An org-funded ₹1,000 seat with the refund/dispute history the clamp reads. */
function seat(
  id: string,
  refunds: { amountPaise: number; status: string }[] = [],
) {
  return {
    id,
    amount: 100_000,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    displayCurrencyAtCheckout: null,
    exchangeRateAtCheckout: null,
    paymentIntent: `org_wallet_${id}`,
    refunds,
    disputes: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRefundCreate.mockImplementation(
    async ({ data }: { data: { paymentId: string } }) => ({
      id: `child-${data.paymentId}`,
    }),
  );
  mockRefundUpdate.mockResolvedValue({});
  mockApplyRefundCascade.mockResolvedValue({ memberOverageRefundDue: null });
});

describe("refundWholeEventPayments clamps internal seats to their refundable balance", () => {
  it("refunds only the seat with a balance when the other was already refunded in full", async () => {
    const seats = [
      seat("seat-a", [{ amountPaise: 100_000, status: "SUCCEEDED" }]),
      seat("seat-b"),
    ];
    mockPaymentFindMany.mockResolvedValue(seats);
    mockTxPaymentFindMany.mockResolvedValue(seats);

    const summary = await refundWholeEventPayments(
      "class",
      "class-1",
      "cancelled",
      "admin-1",
    );

    // One child row, for seat B, for its whole ₹1,000 — nothing for seat A.
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockRefundCreate.mock.calls[0][0].data).toMatchObject({
      paymentId: "seat-b",
      amountPaise: 100_000,
    });
    expect(mockApplyRefundCascade).toHaveBeenCalledTimes(1);
    expect(mockApplyRefundCascade.mock.calls[0][1]).toMatchObject({
      paymentId: "seat-b",
      amountPaise: 100_000,
    });
    expect(summary).toMatchObject({
      refundsIssued: 1,
      refundedPaise: 100_000,
      childRefundIds: ["child-seat-b"],
      failures: [],
      alreadyRefunded: false,
    });
  });

  it("a second identical call reverses nothing and reports alreadyRefunded", async () => {
    const seats = [
      seat("seat-a", [{ amountPaise: 100_000, status: "SUCCEEDED" }]),
      seat("seat-b", [{ amountPaise: 100_000, status: "SUCCEEDED" }]),
    ];
    mockPaymentFindMany.mockResolvedValue(seats);
    mockTxPaymentFindMany.mockResolvedValue(seats);

    const summary = await refundWholeEventPayments(
      "class",
      "class-1",
      "cancelled",
      "admin-1",
    );

    expect(mockRefundCreate).not.toHaveBeenCalled();
    expect(mockApplyRefundCascade).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      refundsIssued: 0,
      refundedPaise: 0,
      childRefundIds: [],
      failures: [],
      skippedAlreadyRefunded: 2,
      alreadyRefunded: true,
    });
  });
});
