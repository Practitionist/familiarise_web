/**
 * @jest-environment node
 */

/**
 * #689 — recording/resource access keys off SUCCEEDED payments, but a refund
 * never flips paymentStatus (the enum has no REFUNDED). These pin the shared
 * refund-aware entitlement: a fully-refunded buyer loses access, a partially
 * refunded one keeps it, and FAILED/CANCELLED refunds don't count.
 */

import { RefundStatus } from "@prisma/client";
import {
  isFullyRefundedPurchase,
  isPaymentEntitled,
  refundedPaise,
} from "@/lib/payments/utils/refund-balance";

describe("refundedPaise", () => {
  it("counts SUCCEEDED and PENDING refunds, ignores FAILED/CANCELLED", () => {
    expect(
      refundedPaise([
        { amountPaise: 300, status: RefundStatus.SUCCEEDED },
        { amountPaise: 200, status: RefundStatus.PENDING },
        { amountPaise: 999, status: RefundStatus.FAILED },
        { amountPaise: 999, status: RefundStatus.CANCELLED },
      ]),
    ).toBe(500);
  });

  it("is zero with no refunds", () => {
    expect(refundedPaise([])).toBe(0);
  });
});

describe("isPaymentEntitled", () => {
  it("keeps access with no refunds", () => {
    expect(isPaymentEntitled({ amount: 1000, refunds: [] })).toBe(true);
  });

  it("keeps access on a partial refund", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 400, status: RefundStatus.SUCCEEDED }],
      }),
    ).toBe(true);
  });

  it("revokes access once refunds cover the full amount", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.SUCCEEDED }],
      }),
    ).toBe(false);
  });

  it("revokes access when a refund is still PENDING but covers the amount", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.PENDING }],
      }),
    ).toBe(false);
  });

  it("keeps access when the only refund covering the amount FAILED", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.FAILED }],
      }),
    ).toBe(true);
  });
});

describe("isFullyRefundedPurchase", () => {
  const cash = (refunds: { amountPaise: number; status: RefundStatus }[]) => ({
    amount: 1000,
    paymentIntent: "order_1",
    refunds,
  });
  const credit = (status?: RefundStatus) => ({
    amount: 0,
    paymentIntent: "free_1",
    refunds: status ? [{ amountPaise: 0, status }] : [],
  });

  it("revokes a cash purchase refunded in full", () => {
    expect(
      isFullyRefundedPurchase([
        cash([{ amountPaise: 1000, status: RefundStatus.SUCCEEDED }]),
      ]),
    ).toBe(true);
  });

  it("keeps a cash purchase refunded in part", () => {
    expect(
      isFullyRefundedPurchase([
        cash([{ amountPaise: 400, status: RefundStatus.SUCCEEDED }]),
      ]),
    ).toBe(false);
  });

  it("revokes a cash purchase whose full refund is still PENDING", () => {
    expect(
      isFullyRefundedPurchase([
        cash([{ amountPaise: 1000, status: RefundStatus.PENDING }]),
      ]),
    ).toBe(true);
  });

  it("revokes a credit-funded purchase once its credits are restored, not on a FAILED one", () => {
    expect(isFullyRefundedPurchase([credit(RefundStatus.SUCCEEDED)])).toBe(
      true,
    );
    expect(isFullyRefundedPurchase([credit(RefundStatus.FAILED)])).toBe(false);
    expect(isFullyRefundedPurchase([credit()])).toBe(false);
  });

  it("never revokes a free booking", () => {
    expect(isFullyRefundedPurchase([])).toBe(false);
    expect(
      isFullyRefundedPurchase([
        { amount: 0, paymentIntent: "trial_free", refunds: [] },
      ]),
    ).toBe(false);
  });
});
