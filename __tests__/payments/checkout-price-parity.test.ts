/**
 * @jest-environment node
 */

/**
 * #1167 — the price the buyer reads and the price the server charges.
 *
 * The checkout pages compute their own breakdown with `app/checkout/plans/math`
 * and render it; `/api/checkout` computes the amount it actually mints an order
 * for, independently, in `lib/payments/operations/checkout.ts`. Nothing has
 * ever compared the two, so any drift between them shows up as a buyer being
 * charged something other than what the page said.
 *
 * RESIDUAL, stated plainly: the server's derivation lives inside
 * `createCheckoutSession`'s Prisma transaction (checkout.ts ~:470-538) and is
 * not exported, so it cannot be imported without standing up prisma, razorpay
 * and stripe. What is imported here is every PURE server primitive that
 * derivation uses — `determineTax` and `MIN_CREDIT_REDEMPTION_PAISE` — wrapped
 * in `serverAmount()`, a transcription of the server's order of operations.
 * That keeps the tax rate, the tax rounding and the credit floor honest against
 * real server code; only the sequencing is restated, and it is restated once,
 * here, where a change to checkout.ts that this suite does not know about is a
 * visible failure rather than a silent one.
 */

import { calculatePricing } from "@/app/checkout/plans/math";
import { determineTax } from "@/lib/payments/tax/tax-engine";
import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";

type ServerInputs = {
  /** Plan price in paise. */
  basePaise: number;
  buyerCountry: string;
  discount?:
    | { type: "PERCENTAGE"; value: number; maxDiscount?: number | null }
    | { type: "FIXED_AMOUNT"; value: number };
  creditsAvailablePaise?: number;
};

type Amounts = { taxPaise: number; creditsPaise: number; totalPaise: number };

/**
 * The server's order of operations: discount, then tax on the discounted base,
 * then credits against the tax-inclusive total. Mirrors checkout.ts ~:470-538.
 */
function serverAmount(input: ServerInputs): Amounts {
  let amount = input.basePaise;

  if (input.discount?.type === "PERCENTAGE") {
    let discountAmount = Math.round(amount * (input.discount.value / 100));
    const cap = input.discount.maxDiscount;
    if (cap !== null && cap !== undefined && discountAmount > cap) {
      discountAmount = cap;
    }
    amount = amount - discountAmount;
  } else if (input.discount?.type === "FIXED_AMOUNT") {
    amount = Math.max(0, amount - input.discount.value);
  }

  const taxPaise = determineTax({
    baseAmountPaise: amount,
    buyerCountry: input.buyerCountry,
    serviceType: "CONSULTING",
  }).taxAmount;
  amount = amount + taxPaise;

  // #880 — credits redeem only on orders at or above the floor.
  let creditsPaise = 0;
  const available = input.creditsAvailablePaise ?? 0;
  if (available > 0 && amount >= MIN_CREDIT_REDEMPTION_PAISE) {
    creditsPaise = Math.min(available, amount);
    amount = amount - creditsPaise;
  }

  return { taxPaise, creditsPaise, totalPaise: amount };
}

/** The same booking as the checkout page computes it. */
function clientAmount(input: ServerInputs): Amounts {
  const breakdown = calculatePricing(input.basePaise, {
    isInternational: input.buyerCountry !== "IN",
    discountPercent:
      input.discount?.type === "PERCENTAGE" && !input.discount.maxDiscount
        ? input.discount.value / 100
        : 0,
    // The pages prefer the API's pre-computed `discountAmount` whenever the
    // validate endpoint returns one, which is how a capped percentage arrives.
    discountAmount:
      input.discount?.type === "FIXED_AMOUNT"
        ? input.discount.value
        : input.discount?.type === "PERCENTAGE" && input.discount.maxDiscount
          ? Math.min(
              Math.round(input.basePaise * (input.discount.value / 100)),
              input.discount.maxDiscount,
            )
          : undefined,
    creditsApplied: input.creditsAvailablePaise ?? 0,
  });
  return {
    taxPaise: breakdown.taxAmount,
    creditsPaise: breakdown.creditsApplied,
    totalPaise: breakdown.total,
  };
}

/**
 * One paise. The two sides round differently by construction — the client keeps
 * two decimal places of a paise value (`Math.round(x * 100) / 100`) while the
 * server rounds to whole paise — so equality is the wrong assertion and a
 * tolerance wider than a paise would hide a real divergence.
 */
const ONE_PAISE = 1;

const FIXTURES: Array<{ name: string; input: ServerInputs }> = [
  {
    name: "base price, domestic",
    input: { basePaise: 500000, buyerCountry: "IN" },
  },
  {
    name: "base price with a fractional GST result",
    input: { basePaise: 123457, buyerCountry: "IN" },
  },
  {
    name: "base price, international (zero-rated export)",
    input: { basePaise: 500000, buyerCountry: "US" },
  },
  {
    name: "percentage discount, domestic",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 15 },
    },
  },
  {
    name: "percentage discount hitting its maxDiscount cap",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 50, maxDiscount: 100000 },
    },
  },
  {
    name: "fixed-amount discount, domestic",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 75000 },
    },
  },
  {
    name: "fixed-amount discount larger than the price",
    input: {
      basePaise: 40000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 90000 },
    },
  },
  {
    name: "credits applied above the redemption floor",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 100000,
    },
  },
  {
    name: "credits covering the whole tax-inclusive total",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 10000000,
    },
  },
  {
    name: "discount and credits together",
    input: {
      basePaise: 800000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 10 },
      creditsAvailablePaise: 150000,
    },
  },
];

describe("checkout price parity — page math vs server derivation", () => {
  it.each(FIXTURES)("$name: totals agree", ({ input }) => {
    const client = clientAmount(input);
    const server = serverAmount(input);
    expect(Math.abs(client.totalPaise - server.totalPaise)).toBeLessThanOrEqual(
      ONE_PAISE,
    );
  });

  it.each(FIXTURES)("$name: tax agrees", ({ input }) => {
    const client = clientAmount(input);
    const server = serverAmount(input);
    expect(Math.abs(client.taxPaise - server.taxPaise)).toBeLessThanOrEqual(
      ONE_PAISE,
    );
  });

  it.each(FIXTURES)("$name: credits applied agree", ({ input }) => {
    const client = clientAmount(input);
    const server = serverAmount(input);
    expect(
      Math.abs(client.creditsPaise - server.creditsPaise),
    ).toBeLessThanOrEqual(ONE_PAISE);
  });
});

describe("checkout price parity — the edges that actually move money", () => {
  it("zero-rates an international buyer on both sides", () => {
    const input: ServerInputs = { basePaise: 500000, buyerCountry: "DE" };
    expect(serverAmount(input).taxPaise).toBe(0);
    expect(clientAmount(input).taxPaise).toBe(0);
  });

  it("charges 18% GST on the DISCOUNTED base, not the list price", () => {
    const input: ServerInputs = {
      basePaise: 100000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 20000 },
    };
    // 18% of ₹800, not of ₹1000.
    expect(serverAmount(input).taxPaise).toBe(14400);
    expect(clientAmount(input).taxPaise).toBe(14400);
  });

  it("never lets a discount drive the total below zero", () => {
    const input: ServerInputs = {
      basePaise: 40000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 90000 },
    };
    expect(serverAmount(input).totalPaise).toBe(0);
    expect(clientAmount(input).totalPaise).toBe(0);
  });

  it("never applies more credit than the total owed", () => {
    const input: ServerInputs = {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 99_999_999,
    };
    expect(serverAmount(input).totalPaise).toBe(0);
    expect(clientAmount(input).totalPaise).toBe(0);
  });

  /**
   * A known, live divergence rather than a wish. `MIN_CREDIT_REDEMPTION_PAISE`
   * is enforced only on the server, so on an order under ₹500 the page shows a
   * credit that the charge will not honour — the one case in this suite where
   * the two sides disagree by more than rounding. Asserted so the gap is
   * recorded and its eventual fix (teaching the pages the floor) turns this
   * test red instead of passing silently.
   */
  it("DIVERGES: the pages ignore the ₹500 credit-redemption floor", () => {
    const input: ServerInputs = {
      basePaise: 30000, // ₹300 + 18% = ₹354, below the floor
      buyerCountry: "IN",
      creditsAvailablePaise: 20000,
    };
    const server = serverAmount(input);
    const client = clientAmount(input);

    expect(server.totalPaise).toBeLessThan(MIN_CREDIT_REDEMPTION_PAISE);
    expect(server.creditsPaise).toBe(0);
    expect(client.creditsPaise).toBe(20000);
    expect(client.totalPaise).toBe(server.totalPaise - 20000);
  });
});
