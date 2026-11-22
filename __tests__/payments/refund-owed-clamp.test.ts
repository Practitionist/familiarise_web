/**
 * @jest-environment node
 */

/**
 * A fixed amount owed that a later refund pushed past the balance is paid up to
 * what is still refundable, never refused into "refund by hand".
 */
const mockRefundBookingPayment = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockFindDeduped = jest.fn(
  async (..._a: unknown[]): Promise<unknown> => null,
);

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  },
}));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  findDedupedRefund: (...a: unknown[]) => mockFindDeduped(...a),
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));

import { driveRefundOwed } from "@/lib/payments/operations/refund-owed";
import { RefundValidationError } from "@/lib/payments/operations/refund";

const exceeds = () =>
  new (
    RefundValidationError as unknown as new (
      message: string,
      code: string,
    ) => Error
  )("exceeds refundable", "AMOUNT_EXCEEDS_REFUNDABLE");

const marker = {
  paymentId: "pay-1",
  amountPaise: 59_000,
  key: "cancel:appt-1:pay-1",
  reason: "cancellation (50% per booking-time policy, consultee-initiated)",
};

beforeEach(() => {
  mockRefundBookingPayment.mockReset();
  mockPaymentFindUnique.mockReset();
});

describe("a fixed-amount owed marker against a shrunken balance", () => {
  it("pays what is still refundable instead of failing", async () => {
    // ₹1,180 paid; ₹800 refunded by support after the stamp: ₹380 left.
    mockPaymentFindUnique.mockResolvedValue({
      amount: 118_000,
      refunds: [{ amountPaise: 80_000, status: "SUCCEEDED" }],
      disputes: [],
    });
    mockRefundBookingPayment
      .mockRejectedValueOnce(exceeds())
      .mockImplementation(async (input: { amountPaise: number }) => ({
        refundId: "rf-2",
        amountRefundedPaise: input.amountPaise,
        status: "SUCCEEDED",
      }));

    const outcome = await driveRefundOwed(marker);

    expect(outcome.kind).toBe("refunded");
    expect(mockRefundBookingPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountPaise: 38_000, dedupeKey: marker.key }),
    );
  });

  it("settles when nothing is left to give back", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      amount: 118_000,
      refunds: [{ amountPaise: 118_000, status: "SUCCEEDED" }],
      disputes: [],
    });
    mockRefundBookingPayment.mockRejectedValue(exceeds());

    const outcome = await driveRefundOwed(marker);

    expect(outcome.kind).toBe("settled");
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("asks for the stamped amount when the balance still covers it", async () => {
    mockRefundBookingPayment.mockImplementation(
      async (input: { amountPaise: number }) => ({
        refundId: "rf-1",
        amountRefundedPaise: input.amountPaise,
        status: "SUCCEEDED",
      }),
    );

    await driveRefundOwed(marker);

    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 59_000 }),
    );
  });
});

describe("two drives racing one clamped marker", () => {
  it("the loser's amount mismatch answers the winner's settled refund and clears the marker", async () => {
    // ₹800 owed on a ₹500 balance: the winner clamped to ₹500 and settled under the key.
    const clamped = { ...marker, amountPaise: 80_000 };
    mockFindDeduped.mockResolvedValueOnce(null).mockResolvedValueOnce({
      refundId: "rf-clamped",
      amountRefundedPaise: 50_000,
      status: "SUCCEEDED",
    });
    mockRefundBookingPayment.mockRejectedValue(
      new (
        RefundValidationError as unknown as new (m: string, c: string) => Error
      )("key reused", "IDEMPOTENCY_KEY_REUSED"),
    );
    const prisma = jest.requireMock("@/lib/prisma").default as {
      payment: { updateMany: jest.Mock };
    };
    prisma.payment.updateMany.mockClear();

    const outcome = await driveRefundOwed(clamped);

    expect(outcome).toEqual({
      kind: "replayed",
      refund: {
        refundId: "rf-clamped",
        amountRefundedPaise: 50_000,
        status: "SUCCEEDED",
      },
    });
    expect(mockFindDeduped).toHaveBeenLastCalledWith(clamped.key, {
      paymentId: clamped.paymentId,
    });
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: clamped.paymentId, refundOwedKey: clamped.key },
      }),
    );
  });
});

describe("a full credit restoration under a plan-end key", () => {
  const restore = {
    paymentId: "pay-credit",
    amountPaise: null,
    key: "plan-end:sub-1:pay:pay-credit",
    reason: "PLAN_ENDED_UNUSED_SESSIONS",
  };

  it("asks the credits rail for the whole credit, with no amount", async () => {
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "rf-c",
      amountRefundedPaise: 0,
      rail: "CREDITS",
      status: "SUCCEEDED",
    });
    await driveRefundOwed(restore);
    const input = mockRefundBookingPayment.mock.calls[0][0] as {
      amountPaise?: number;
    };
    expect(input.amountPaise).toBeUndefined();
  });

  it("replays an earlier restoration under the same key instead of restoring twice", async () => {
    mockFindDeduped.mockResolvedValueOnce({
      refundId: "rf-first",
      amountRefundedPaise: 0,
      status: "SUCCEEDED",
    });
    const outcome = await driveRefundOwed(restore);
    expect(outcome.kind).toBe("replayed");
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("settles when the credit was already restored by another door", async () => {
    mockRefundBookingPayment.mockRejectedValue(
      new (
        RefundValidationError as unknown as new (
          message: string,
          code: string,
        ) => Error
      )("already restored", "ALREADY_FULLY_REFUNDED"),
    );
    const outcome = await driveRefundOwed(restore);
    expect(outcome.kind).toBe("settled");
  });
});
