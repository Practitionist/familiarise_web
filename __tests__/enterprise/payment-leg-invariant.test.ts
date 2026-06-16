/**
 * @jest-environment node
 */

/**
 * PaymentLeg sum invariant tests.
 *
 * Covers the two helpers added in the close-bundle commit:
 *   - checkPaymentLegsSumToAmount — log-only soft check for the hot
 *     checkout path; returns a mismatch payload rather than throwing.
 *   - assertPaymentLegsSumToAmount — hard-throwing sibling for tests +
 *     reconciliation jobs.
 *
 * The invariant: `sum(legs.amountPaise) === Payment.amount`. LICENSE
 * legs intentionally carry zero amount (cost absorbed at contract time)
 * and are still part of the sum. Referral-credit flows mix a CARD leg
 * (post-credit gateway charge) with a REFERRAL_CREDIT leg (the credit
 * value) whose sum equals Payment.amount (post-credit).
 */

import {
  checkPaymentLegsSumToAmount,
  assertPaymentLegsSumToAmount,
} from "@/lib/payments/payment-legs";

describe("checkPaymentLegsSumToAmount", () => {
  it("returns null when a single CARD leg matches the amount", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 150000,
        legs: [{ source: "CARD", amountPaise: 150000 }],
      }),
    ).toBeNull();
  });

  it("returns null when a WALLET leg equals the full amount (org-sponsored, no gateway)", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 50000,
        legs: [{ source: "WALLET", amountPaise: 50000 }],
      }),
    ).toBeNull();
  });

  it("returns null for a LICENSE leg at zero amount on a zero-amount Payment", () => {
    // LICENSE flows: cost is sunk at contract time, Payment.amount = 0,
    // leg.amountPaise = 0. The invariant still holds (0 === 0).
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 0,
        legs: [{ source: "LICENSE", amountPaise: 0 }],
      }),
    ).toBeNull();
  });

  it("returns null when CARD + REFERRAL_CREDIT legs sum to Payment.amount", () => {
    // Post-credit scenario: gateway charged 100 paise, credits covered
    // 50, Payment.amount = 150 (pre-credit total).
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 150,
        legs: [
          { source: "CARD", amountPaise: 100 },
          { source: "REFERRAL_CREDIT", amountPaise: 50 },
        ],
      }),
    ).toBeNull();
  });

  it("returns a mismatch payload when legs sum is less than the amount", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 100,
      legs: [{ source: "CARD", amountPaise: 60 }],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.paymentAmountPaise).toBe(100);
    expect(mismatch?.legSumPaise).toBe(60);
    expect(mismatch?.deltaPaise).toBe(-40); // signed: sum - amount
  });

  it("returns a mismatch payload when legs sum exceeds the amount", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 100,
      legs: [
        { source: "CARD", amountPaise: 80 },
        { source: "REFERRAL_CREDIT", amountPaise: 40 },
      ],
    });
    expect(mismatch?.deltaPaise).toBe(20);
    expect(mismatch?.legs).toHaveLength(2);
  });

  it("treats an empty leg array as sum = 0 (mismatch if amount != 0)", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500,
      legs: [],
    });
    expect(mismatch?.legSumPaise).toBe(0);
    expect(mismatch?.deltaPaise).toBe(-500);
  });

  it("allows negative leg amounts (refund adjustments)", () => {
    // Refund ledger writes a negative leg without deleting the original
    // positive leg; the check must net them signed, not via abs().
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 0,
        legs: [
          { source: "CARD", amountPaise: 100 },
          { source: "CARD", amountPaise: -100 },
        ],
      }),
    ).toBeNull();
  });
});

describe("assertPaymentLegsSumToAmount", () => {
  it("does not throw on a matching sum", () => {
    expect(() =>
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "CARD", amountPaise: 100 }],
      }),
    ).not.toThrow();
  });

  it("throws with a descriptive message on mismatch", () => {
    expect(() =>
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "CARD", amountPaise: 50 }],
      }),
    ).toThrow(/PaymentLeg sum invariant violated/);
  });

  it("error message includes the delta for ops visibility", () => {
    try {
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "WALLET", amountPaise: 60 }],
      });
      throw new Error("expected assertion to throw");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      expect(err.message).toContain("delta -40");
    }
  });
});
