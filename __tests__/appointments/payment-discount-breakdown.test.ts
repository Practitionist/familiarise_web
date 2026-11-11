import { paymentDiscountBreakdown } from "@/lib/appointments/payment-display";

const base = { originalAmount: 100_000, hasDiscountCode: true };

describe("paymentDiscountBreakdown", () => {
  it("reads a 10% code off a taxed order", () => {
    // 100000 - 10000 = 90000; GST 16200; the buyer paid 106200.
    expect(
      paymentDiscountBreakdown({ ...base, taxAmount: 16_200, amount: 106_200 }),
    ).toEqual({ codeDiscountPaise: 10_000, welcomeDiscountPaise: 0 });
  });

  it("reads a code off an order with no GST", () => {
    expect(
      paymentDiscountBreakdown({ ...base, taxAmount: 0, amount: 90_000 }),
    ).toEqual({ codeDiscountPaise: 10_000, welcomeDiscountPaise: 0 });
  });

  it("does not count referral credit as the code discount", () => {
    // 106200 after the code, 20000 spent as credit, 86200 charged to the card.
    expect(
      paymentDiscountBreakdown({
        ...base,
        taxAmount: 16_200,
        amount: 86_200,
        legs: [
          { source: "CARD", amountPaise: 86_200 },
          { source: "REFERRAL_CREDIT", amountPaise: 20_000 },
        ],
      }),
    ).toEqual({ codeDiscountPaise: 10_000, welcomeDiscountPaise: 0 });
  });

  it("reports the welcome discount and no code discount when there is no code", () => {
    // Welcome 17200 off 100000; GST 18% of 82800 = 14904; paid 97704.
    expect(
      paymentDiscountBreakdown({
        originalAmount: 100_000,
        taxAmount: 14_904,
        amount: 97_704,
        welcomeDiscountPaise: 17_200,
        hasDiscountCode: false,
      }),
    ).toEqual({ codeDiscountPaise: 0, welcomeDiscountPaise: 17_200 });
  });

  it("splits a code and a welcome discount stored together", () => {
    expect(
      paymentDiscountBreakdown({
        ...base,
        welcomeDiscountPaise: 5_000,
        taxAmount: 15_300,
        amount: 100_300,
      }),
    ).toEqual({ codeDiscountPaise: 10_000, welcomeDiscountPaise: 5_000 });
  });

  it("never reports a negative discount and accepts bigint or string paise", () => {
    expect(
      paymentDiscountBreakdown({
        originalAmount: BigInt(100_000),
        taxAmount: "18000",
        amount: 118_000,
        welcomeDiscountPaise: null,
        hasDiscountCode: true,
      }),
    ).toEqual({ codeDiscountPaise: 0, welcomeDiscountPaise: 0 });
    expect(
      paymentDiscountBreakdown({ ...base, taxAmount: 0, amount: 120_000 }),
    ).toEqual({ codeDiscountPaise: 0, welcomeDiscountPaise: 0 });
  });
});
