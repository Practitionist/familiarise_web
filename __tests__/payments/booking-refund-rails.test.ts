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
 *
 * SCOPE: this suite stubs `applyReversal`, so it proves ROUTING and nothing
 * about the reversal itself — not its postings, not its balance, not its
 * idempotency. Stubbing the engine here is deliberate (the routing decision is
 * what this module owns), but it does mean a cascade that reverses earnings
 * without posting a journal would sail through untouched. That class of bug is
 * covered by `license-refund-ledger.test.ts`, which runs the real cascade.
 */

const mockRefundPayment = jest.fn();
const mockApplyReversal = jest.fn();
const mockReverseCredits = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockRefundFindMany = jest.fn();
const mockRefundCreate = jest.fn();
const mockRefundUpdate = jest.fn();
const mockRefundFindUnique = jest.fn();
const mockFindDedupedRefund = jest.fn(
  async (_key?: string): Promise<unknown> => null,
);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a) },
    refund: {
      findMany: (...a: unknown[]) => mockRefundFindMany(...a),
      findUnique: (...a: unknown[]) => mockRefundFindUnique(...a),
    },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        appointmentParticipant: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        refund: {
          findMany: (...a: unknown[]) => mockRefundFindMany(...a),
          create: (...a: unknown[]) => mockRefundCreate(...a),
          update: (...a: unknown[]) => mockRefundUpdate(...a),
          updateMany: async (...a: unknown[]) => {
            mockRefundUpdate(...a);
            return { count: 1 };
          },
        },
      }),
  },
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  findDedupedRefund: (key?: string) => mockFindDedupedRefund(key),
  isDedupeKeyConflict: () => false,
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

// #1589 N-P0-01 — the in-tx notice pair and its post-commit attempts.
const mockNotifyRefundProcessed = jest.fn();
const mockAttemptTrigger = jest.fn();
const mockStageRefundProcessedEmail = jest.fn();
const mockAttemptStagedEmails = jest.fn();
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: (...a: unknown[]) => mockNotifyRefundProcessed(...a),
  attemptTrigger: (...a: unknown[]) => mockAttemptTrigger(...a),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "REFUND_PROCESSED" },
  stageRefundProcessedEmail: (...a: unknown[]) =>
    mockStageRefundProcessedEmail(...a),
  prepareRefundProcessedEmail: jest.fn(async () => null),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: (...a: unknown[]) => mockAttemptStagedEmails(...a),
}));
const mockTransitionParticipant = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) => mockTransitionParticipant(...a),
}));
type RefundIntent = { refundId: string; payerUserId: string };
const mockRevokeRefundedSeatAccess = jest.fn(
  async (_intent: RefundIntent) => undefined,
);
const mockPersistRefundRevocation = jest.fn(
  async (_intent: RefundIntent) => undefined,
);
jest.mock("../../lib/stream/access-revocation", () => ({
  revokeRefundedSeatAccess: (intent: RefundIntent) =>
    mockRevokeRefundedSeatAccess(intent),
  persistRefundRevocation: (intent: RefundIntent) =>
    mockPersistRefundRevocation(intent),
}));

import {
  refundBookingPayment,
  restampRefundedSeats,
} from "../../lib/payments/operations/booking-refund";
import { isInternalFundedIntent } from "../../lib/payments/funding-rail";

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
  mockFindDedupedRefund.mockResolvedValue(null);
  mockRefundCreate.mockResolvedValue({ id: "refund-row-1" });
  mockRefundUpdate.mockResolvedValue({});
  mockApplyReversal.mockResolvedValue({
    kind: "BOOKING",
    cascades: [],
    childRefundIds: [],
    clawbackPosted: false,
  });
  mockReverseCredits.mockResolvedValue(0);
  mockNotifyRefundProcessed.mockResolvedValue({ staged: { id: "bell-1" } });
  mockStageRefundProcessedEmail.mockResolvedValue([]);
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
      expect(isInternalFundedIntent(intent)).toBe(false);
    },
  );

  it("does not classify a fully-credit-funded booking as org-funded", () => {
    // `free_` is a THIRD rail this module does not yet serve: those payments
    // are zero-amount, so callers filter them out on `amount > 0` and their
    // credits and program utilization are never reversed on cancellation. That
    // is an open gap, not a solved case — asserted here only so the rail
    // predicate does not silently absorb it into the org branch.
    expect(isInternalFundedIntent("free_1730000000_abc")).toBe(false);
  });
});

describe("refundBookingPayment", () => {
  it("sends a card payment down the gateway path unchanged", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      paymentIntent: "pay_ABC",
      userId: "payer-1",
    });
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
    expect(mockRevokeRefundedSeatAccess).toHaveBeenCalledWith({
      refundId: "r1",
      payerUserId: "payer-1",
    });
  });

  it("keeps a per-session refund's chat and call access", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      paymentIntent: "pay_ABC",
      userId: "payer-1",
    });
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 10_000,
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 10_000,
      reason: "missed session",
      keepSeat: true,
    });

    expect(mockRevokeRefundedSeatAccess).not.toHaveBeenCalled();
  });

  it("reverses an org-wallet booking in-ledger, never through the gateway", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
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
      .mockResolvedValueOnce({
        paymentIntent: "org_invoice_1_a",
        userId: "payer-1",
      })
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
      where: { id: "refund-row-1", status: "PENDING" },
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
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    expect(order).toEqual(["succeeded", "credits"]);
    // Positional signature: a swap of `requested` and `payment.amount` would
    // under- or over-restore credits and the ordering assertion alone would
    // still pass.
    expect(mockReverseCredits).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.anything(),
      100_000,
      100_000,
      "refund-row-1",
    );
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
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
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
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce({
        ...orgFundedPayment("org_wallet_1_a"),
        paymentStatus: "PENDING",
      });

    await expect(
      refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancellation" }),
    ).rejects.toThrow(/not SUCCEEDED/);
  });
});

// #1589 N-P0-01 — a gateway refund is announced by the `refund.processed`
// webhook; the org rail settles in one transaction and told the payer nothing.
describe("the internal rail tells the payer (#1589 N-P0-01)", () => {
  it("stages one refund-processed notice inside the tx and attempts it after", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      ...orgFundedPayment("org_wallet_1_a"),
      userId: "user-1",
      organizationId: "org-1",
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
      initiatedByUserId: "user-1",
    });

    expect(mockNotifyRefundProcessed).toHaveBeenCalledTimes(1);
    const [userId, payload, opts] = mockNotifyRefundProcessed.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(payload).toMatchObject({ amount: 100_000, currency: "INR" });
    expect(opts).toMatchObject({
      entityRef: `payment:${PAYMENT_ID}`,
      tx: expect.anything(),
    });
    expect(mockStageRefundProcessedEmail).toHaveBeenCalledTimes(1);
    expect(mockAttemptTrigger).toHaveBeenCalledWith({ id: "bell-1" });
    expect(mockAttemptStagedEmails).toHaveBeenCalledTimes(1);
  });

  it("a partial refund tells the payer the requested amount, not the payment's", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      ...orgFundedPayment("org_wallet_1_a"),
      userId: "user-1",
      organizationId: "org-1",
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 40_000,
      reason: "late cancellation, 40% tier",
    });

    expect(mockNotifyRefundProcessed.mock.calls[0][1]).toMatchObject({
      amount: 40_000,
    });
    expect(mockStageRefundProcessedEmail.mock.calls[0][1]).toMatchObject({
      amountPaise: 40_000,
    });
  });

  it("stages nothing for a gateway refund — the webhook owns that notice", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      paymentIntent: "pay_ABC",
      userId: "payer-1",
    });
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 100_000,
    });

    await refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancel" });

    expect(mockNotifyRefundProcessed).not.toHaveBeenCalled();
    expect(mockStageRefundProcessedEmail).not.toHaveBeenCalled();
  });
});

describe("keepSeatIfPartial: the seat ends once the payment is fully returned", () => {
  const seatEnded = () =>
    mockTransitionParticipant.mock.calls.some((c) => c[2] === "REFUNDED");

  it("internal rail: a partial keeps the seat", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 10_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });

    expect(seatEnded()).toBe(false);
  });

  it("internal rail: an explicit amount equal to the balance ends the seat", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 100_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });

    expect(seatEnded()).toBe(true);
  });

  it("internal rail: a partial that returns the rest ends the seat", async () => {
    mockRefundFindMany.mockResolvedValue([{ amountPaise: 60_000 }]);
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 40_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });

    expect(seatEnded()).toBe(true);
  });

  const gatewayBalance = (
    refunds: number[],
    disputes: { amountPaise: number; status: string }[] = [],
  ) => ({
    paymentIntent: "pay_ABC",
    userId: "payer-1",
    amount: 100_000,
    refunds: refunds.map((amountPaise) => ({
      amountPaise,
      status: "SUCCEEDED",
    })),
    disputes,
  });

  it("gateway rail: reads the rail's own balance after the refund commits", async () => {
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 1,
    });

    mockPaymentFindUnique.mockResolvedValue(gatewayBalance([40_000]));
    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 40_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });
    expect(seatEnded()).toBe(false);

    mockPaymentFindUnique.mockResolvedValue(gatewayBalance([40_000, 60_000]));
    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 60_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });
    expect(seatEnded()).toBe(true);
  });

  it("gateway rail: a lost chargeback counts toward the returned total", async () => {
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 1,
    });
    mockPaymentFindUnique.mockResolvedValue(
      gatewayBalance([70_000], [{ amountPaise: 30_000, status: "LOST" }]),
    );

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      amountPaise: 70_000,
      reason: "goodwill",
      keepSeatIfPartial: true,
    });

    expect(seatEnded()).toBe(true);
  });

  it("gateway rail: an unreadable balance keeps the seat and keeps the refund", async () => {
    mockRefundPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 1,
    });
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "pay_ABC", userId: "payer-1" })
      .mockRejectedValueOnce(new Error("db down"));

    await expect(
      refundBookingPayment({
        paymentId: PAYMENT_ID,
        amountPaise: 10_000,
        reason: "goodwill",
        keepSeatIfPartial: true,
      }),
    ).resolves.toMatchObject({ refundId: "r1", rail: "GATEWAY" });
    expect(seatEnded()).toBe(false);
  });
});

describe("the access revocation a seat-ending refund owes", () => {
  const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

  it("gateway rail: persists the intent before stamping the seat, then drives it", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      paymentIntent: "pay_ABC",
      userId: "payer-1",
    });
    mockRefundPayment.mockResolvedValue({
      refundId: "refund-row-9",
      amountRefundedPaise: 100_000,
    });

    await refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancel" });

    const intent = { refundId: "refund-row-9", payerUserId: "payer-1" };
    expect(mockPersistRefundRevocation).toHaveBeenCalledWith(intent);
    expect(mockRevokeRefundedSeatAccess).toHaveBeenCalledWith(intent);
    expect(order(mockPersistRefundRevocation)).toBeLessThan(
      order(mockTransitionParticipant),
    );
    expect(order(mockTransitionParticipant)).toBeLessThan(
      order(mockRevokeRefundedSeatAccess),
    );
  });

  it("gateway rail: a failed seat stamp still leaves the intent owed and driven", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      paymentIntent: "pay_ABC",
      userId: "payer-1",
    });
    mockRefundPayment.mockResolvedValue({
      refundId: "refund-row-9",
      amountRefundedPaise: 100_000,
    });
    mockTransitionParticipant.mockRejectedValueOnce(new Error("db blip"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancel" }),
    ).resolves.toMatchObject({ refundId: "refund-row-9", rail: "GATEWAY" });

    expect(mockPersistRefundRevocation).toHaveBeenCalledTimes(1);
    expect(mockRevokeRefundedSeatAccess).toHaveBeenCalledTimes(1);
  });

  it("internal rail: stamps inside its transaction and only drives the intent", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a"));

    await refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancel" });

    expect(mockPersistRefundRevocation).not.toHaveBeenCalled();
    expect(mockRevokeRefundedSeatAccess).toHaveBeenCalledWith({
      refundId: "refund-row-1",
      payerUserId: "payer-1",
    });
  });

  it.each([
    [
      "internal",
      () =>
        mockPaymentFindUnique
          .mockResolvedValueOnce({
            paymentIntent: "org_wallet_1_a",
            userId: "payer-1",
          })
          .mockResolvedValueOnce(orgFundedPayment("org_wallet_1_a")),
    ],
    [
      "gateway",
      () =>
        mockPaymentFindUnique
          .mockResolvedValueOnce({
            paymentIntent: "pay_ABC",
            userId: "payer-1",
          })
          .mockResolvedValueOnce({
            paymentIntent: "pay_ABC",
            amount: 100_000,
            refunds: [{ amountPaise: 10_000, status: "SUCCEEDED" }],
            disputes: [],
          }),
    ],
  ])(
    "%s rail: a keepSeatIfPartial partial owes no revocation",
    async (_rail, arrange) => {
      arrange();
      mockRefundPayment.mockResolvedValue({
        refundId: "r1",
        amountRefundedPaise: 10_000,
      });

      await refundBookingPayment({
        paymentId: PAYMENT_ID,
        amountPaise: 10_000,
        reason: "goodwill",
        keepSeatIfPartial: true,
      });

      expect(mockPersistRefundRevocation).not.toHaveBeenCalled();
      expect(mockRevokeRefundedSeatAccess).not.toHaveBeenCalled();
    },
  );
});

describe("restampRefundedSeats", () => {
  it.each(["SUCCEEDED", "PENDING"])(
    "stamps the payment's seats REFUNDED while the refund is %s",
    async (status) => {
      mockRefundFindUnique.mockResolvedValue({ status, paymentId: PAYMENT_ID });

      await expect(restampRefundedSeats("refund-row-1")).resolves.toBe(
        "stamped",
      );
      expect(mockTransitionParticipant).toHaveBeenCalledWith(
        expect.anything(),
        { paymentId: PAYMENT_ID },
        "REFUNDED",
      );
    },
  );

  it.each(["FAILED", "CANCELLED"])(
    "leaves the seat live once the refund is %s, since no money moved",
    async (status) => {
      mockRefundFindUnique.mockResolvedValue({ status, paymentId: PAYMENT_ID });

      await expect(restampRefundedSeats("refund-row-1")).resolves.toBe(
        "skipped",
      );
      expect(mockTransitionParticipant).not.toHaveBeenCalled();
    },
  );

  it("skips a refund row that does not exist", async () => {
    mockRefundFindUnique.mockResolvedValue(null);

    await expect(restampRefundedSeats("missing")).resolves.toBe("skipped");
    expect(mockTransitionParticipant).not.toHaveBeenCalled();
  });
});

describe("an internal-rail refund replayed by its dedupe key", () => {
  // The first call stamped the seat in its transaction, then died before persisting the intent.
  const replay = (refunded: number[]) => {
    mockFindDedupedRefund.mockResolvedValue({
      refundId: "refund-row-1",
      amountRefundedPaise: 100_000,
      status: "SUCCEEDED",
    });
    mockPaymentFindUnique
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        userId: "payer-1",
      })
      .mockResolvedValueOnce({
        paymentIntent: "org_wallet_1_a",
        amount: 100_000,
        refunds: refunded.map((amountPaise) => ({
          amountPaise,
          status: "SUCCEEDED",
        })),
        disputes: [],
      });
    return refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "admin refund",
      dedupeKey: "admin-refund-1",
      keepSeatIfPartial: true,
    });
  };

  it("still owes the revocation when the original refund returned everything", async () => {
    await expect(replay([100_000])).resolves.toMatchObject({
      refundId: "refund-row-1",
      rail: "INTERNAL",
    });

    expect(mockApplyReversal).not.toHaveBeenCalled();
    expect(mockRevokeRefundedSeatAccess).toHaveBeenCalledWith({
      refundId: "refund-row-1",
      payerUserId: "payer-1",
    });
  });

  it("owes nothing when the original refund was a partial that kept the seat", async () => {
    await replay([10_000]);

    expect(mockRevokeRefundedSeatAccess).not.toHaveBeenCalled();
  });
});
