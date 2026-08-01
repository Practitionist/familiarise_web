/**
 * @jest-environment node
 */

/**
 * One booking payment, two funding rails (#1003, #1020).
 *
 * `refundPayment` calls the gateway unconditionally. An org-funded booking
 * carries a synthetic `org_wallet_` / `org_license_` / `org_invoice_` intent
 * that no gateway can resolve, so every org-funded 1:1 cancellation died on
 * UNKNOWN_GATEWAY in Phase 2 — before the cascade ran. Nothing was reversed:
 * the wallet was never credited back, the invoice accrual never netted down,
 * the program engagement never returned to the cap, and the consultant's
 * earnings stayed payable. The cancel route swallowed it as "refunded 0".
 *
 * Pinned here:
 *  - a card/mock intent still goes through the gateway path untouched
 *  - every org_ intent reverses in-ledger through the reversal engine instead
 *  - the in-ledger path mints its own Refund row and settles it SUCCEEDED
 *  - it refuses to oversubscribe an already-refunded payment
 */

const mockRefundPayment = jest.fn();
const mockApplyReversal = jest.fn();
const mockReverseCredits = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockRefundFindMany = jest.fn();
const mockRefundCreate = jest.fn();
const mockRefundUpdate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        refund: {
          findMany: (...a: unknown[]) => mockRefundFindMany(...a),
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
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  RefundValidationError: class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  },
}));

jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => mockApplyReversal(...a),
}));

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => mockReverseCredits(...a),
}));

import {
  isInternalFundedIntent,
  refundBookingPayment,
} from "../../lib/payments/operations/booking-refund";

const PAYMENT_ID = "pay-1";

/** ₹1,000 booking. */
function orgFundedPayment(intent: string) {
  return {
    id: PAYMENT_ID,
    amount: 100_000,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentGateway: "RAZORPAY",
    displayCurrencyAtCheckout: null,
    exchangeRateAtCheckout: null,
    paymentIntent: intent,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRefundFindMany.mockResolvedValue([]);
  mockRefundCreate.mockResolvedValue({ id: "refund-row-1" });
  mockRefundUpdate.mockResolvedValue({});
  mockApplyReversal.mockResolvedValue({
    kind: "BOOKING",
    cascades: [],
    childRefundIds: [],
    clawbackPosted: false,
  });
  mockReverseCredits.mockResolvedValue(0);
});

describe("isInternalFundedIntent", () => {
  it.each(["org_wallet_1_a", "org_license_1_a", "org_invoice_1_a"])(
    "treats %s as internal",
    (intent) => {
      expect(isInternalFundedIntent(intent)).toBe(true);
    },
  );

  it.each(["pay_ABC", "order_ABC", "pi_ABC", "cs_ABC", "rzp_mock_1", "free_1"])(
    "treats %s as gateway-bound",
    (intent) => {
      // `free_` is a zero-amount payment, which never reaches a refund at all —
      // but it must not be mistaken for org funding either.
      expect(isInternalFundedIntent(intent)).toBe(false);
    },
  );
});

describe("refundBookingPayment", () => {
  it("sends a card payment down the gateway path unchanged", async () => {
    mockPaymentFindUnique.mockResolvedValue({ paymentIntent: "pay_ABC" });
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 50_000,
    });

    const result = await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 50_000,
      reason: "cancellation",
      initiatedByUserId: "user-1",
    });

    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, amountPaise: 50_000 }),
    );
    expect(mockApplyReversal).not.toHaveBeenCalled();
    expect(result).toEqual({
      refundId: "r1",
      amountRefundedPaise: 50_000,
      rail: "GATEWAY",
    });
  });

  it("reverses an org-wallet booking in-ledger, never through the gateway", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_wallet_1_a" })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    const result = await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 100_000,
      reason: "cancellation",
      initiatedByUserId: "user-1",
    });

    // The whole point: this used to throw UNKNOWN_GATEWAY here.
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockApplyReversal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: { kind: "BOOKING", paymentId: PAYMENT_ID },
        amountPaise: 100_000,
        refundId: "refund-row-1",
      }),
    );
    expect(result.rail).toBe("INTERNAL");
    expect(result.amountRefundedPaise).toBe(100_000);
  });

  it("mints its own Refund row and settles it SUCCEEDED", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_invoice_1_a" })
      .mockResolvedValueOnce(orgFundedPayment("org_invoice_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
      initiatedByUserId: null,
    });

    // No gateway ever mints an id for these, so the row owns its own.
    expect(mockRefundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: PAYMENT_ID,
          amountPaise: 100_000,
          status: "PENDING",
          refundId: expect.stringMatching(/^internal_/),
        }),
      }),
    );
    expect(mockRefundUpdate).toHaveBeenCalledWith({
      where: { id: "refund-row-1" },
      data: { status: "SUCCEEDED" },
    });
  });

  it("restores referral credits only after the row reads SUCCEEDED", async () => {
    // reverseCreditsForPayment derives its target from the cumulative SUCCEEDED
    // refund total, so running it before the flip under-restores.
    const order: string[] = [];
    mockRefundUpdate.mockImplementation(async () => {
      order.push("succeeded");
      return {};
    });
    mockReverseCredits.mockImplementation(async () => {
      order.push("credits");
      return 0;
    });
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_wallet_1_a" })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    expect(order).toEqual(["succeeded", "credits"]);
  });

  it("defaults to the full remaining balance, net of prior refunds", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_license_1_a" })
      .mockResolvedValueOnce(orgFundedPayment("org_license_1_a"));
    mockRefundFindMany.mockResolvedValue([{ amountPaise: 40_000 }]);

    const result = await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    expect(result.amountRefundedPaise).toBe(60_000);
  });

  it("refuses to oversubscribe a partly-refunded payment", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_wallet_1_a" })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));
    mockRefundFindMany.mockResolvedValue([{ amountPaise: 90_000 }]);

    await expect(
      refundBookingPayment({
        paymentId: PAYMENT_ID,
        amountPaise: 20_000,
        reason: "cancellation",
      }),
    ).rejects.toThrow(/exceeds refundable/);
    expect(mockApplyReversal).not.toHaveBeenCalled();
  });

  it("refuses a payment that never captured", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "org_wallet_1_a" })
      .mockResolvedValueOnce({
        ...orgFundedPayment("org_wallet_1_a"),
        paymentStatus: "PENDING",
      });

    await expect(
      refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancellation" }),
    ).rejects.toThrow(/not SUCCEEDED/);
  });
});
