/**
 * @jest-environment node
 */

/**
 * #775 — pure overage calculator: pass-through marginal + surcharge bps,
 * CREDIT_POOL money-meter, and the per-cycle circuit breaker.
 *
 * The booking-path wiring (recordBookingUtilization + checkout) is covered by
 * the cap tests; this pins the pure math the whole feature rests on.
 */

import { computeOverage } from "@/lib/payments/billing/overage";

describe("computeOverage — LICENSED_SEAT pass-through", () => {
  const base = {
    programType: "LICENSED_SEAT" as const,
    bookingPricePaise: 100_000,
    sessionsConsumed: 1,
    overageBehavior: "CHARGE_ORG" as const,
    maxOveragePerCyclePaise: null,
    cycleOverageSoFarPaise: 0,
  };

  it("within cap → fully covered, no marginal", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 2,
    });
    expect(r.marginalPaise).toBe(0);
    expect(r.decision).toBe("PROCEED");
    expect(r.chargeTo).toBeNull();
  });

  it("over cap → marginal is the real booking price (pass-through, not a flat tier)", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5, // no seats left
    });
    expect(r.marginalPaise).toBe(100_000);
    expect(r.chargeTo).toBe("ORG");
  });

  it("priceCapPerEngagementPaise caps the base marginal", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5,
      priceCapPerEngagementPaise: 40_000,
    });
    expect(r.marginalPaise).toBe(40_000);
  });

  it("surcharge bps marks up the marginal AFTER the price cap", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5,
      priceCapPerEngagementPaise: 40_000,
      overageSurchargeBps: 1000, // +10%
    });
    // 40_000 capped, then +10% = 44_000 (may exceed the cap by the surcharge).
    expect(r.marginalPaise).toBe(44_000);
  });

  it("surcharge with no price cap marks up the full pass-through price", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5,
      overageSurchargeBps: 2500, // +25%
    });
    expect(r.marginalPaise).toBe(125_000);
  });

  it("unlimited cap (LICENSE-funded, null) never overages", () => {
    const r = computeOverage({
      ...base,
      coveredEngagementsPerCycle: null,
      engagementsUsed: 999,
    });
    expect(r.marginalPaise).toBe(0);
    expect(r.decision).toBe("PROCEED");
  });
});

describe("computeOverage — CREDIT_POOL money-meter", () => {
  const base = {
    programType: "CREDIT_POOL" as const,
    sessionsConsumed: 1,
    overageBehavior: "CHARGE_ORG" as const,
    maxOveragePerCyclePaise: null,
    cycleOverageSoFarPaise: 0,
  };

  it("within budget → fully covered", () => {
    const r = computeOverage({
      ...base,
      bookingPricePaise: 30_000,
      creditBudgetPaise: 100_000,
      consumedPaise: 50_000, // 50k remaining ≥ 30k
    });
    expect(r.marginalPaise).toBe(0);
  });

  it("partially over budget → marginal is the over-budget remainder", () => {
    const r = computeOverage({
      ...base,
      bookingPricePaise: 30_000,
      creditBudgetPaise: 100_000,
      consumedPaise: 90_000, // only 10k remaining → 20k marginal
    });
    expect(r.marginalPaise).toBe(20_000);
    expect(r.chargeTo).toBe("ORG");
  });

  it("fully over budget (₹5,000 vs ₹500 session burn different paise)", () => {
    const big = computeOverage({
      ...base,
      bookingPricePaise: 500_000,
      creditBudgetPaise: 100_000,
      consumedPaise: 100_000,
    });
    const small = computeOverage({
      ...base,
      bookingPricePaise: 50_000,
      creditBudgetPaise: 100_000,
      consumedPaise: 100_000,
    });
    // Proof the meter is money, not a flat per-session credit: a ₹5,000 and a
    // ₹500 session over the same exhausted budget produce different marginals.
    expect(big.marginalPaise).toBe(500_000);
    expect(small.marginalPaise).toBe(50_000);
    expect(big.marginalPaise).not.toBe(small.marginalPaise);
  });

  it("surcharge applies to the credit-pool marginal", () => {
    const r = computeOverage({
      ...base,
      bookingPricePaise: 50_000,
      creditBudgetPaise: 100_000,
      consumedPaise: 100_000,
      overageSurchargeBps: 1000, // +10%
    });
    expect(r.marginalPaise).toBe(55_000);
  });
});

describe("computeOverage — circuit breaker + behavior routing", () => {
  const over = {
    programType: "LICENSED_SEAT" as const,
    bookingPricePaise: 100_000,
    sessionsConsumed: 1,
    coveredEngagementsPerCycle: 1,
    engagementsUsed: 1, // over cap
  };

  it("BLOCKs when cycle overage-so-far + marginal exceeds the ceiling", () => {
    const r = computeOverage({
      ...over,
      overageBehavior: "CHARGE_ORG",
      maxOveragePerCyclePaise: 120_000,
      cycleOverageSoFarPaise: 50_000, // 50k + 100k = 150k > 120k
    });
    expect(r.decision).toBe("BLOCK");
    expect(r.chargeTo).toBeNull();
  });

  it("ceiling counts the surcharged marginal", () => {
    const r = computeOverage({
      ...over,
      overageBehavior: "CHARGE_ORG",
      overageSurchargeBps: 5000, // +50% → marginal 150k
      maxOveragePerCyclePaise: 120_000,
      cycleOverageSoFarPaise: 0,
    });
    expect(r.decision).toBe("BLOCK");
  });

  it("routes CHARGE_MEMBER → MEMBER", () => {
    const r = computeOverage({
      ...over,
      overageBehavior: "CHARGE_MEMBER",
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
    });
    expect(r.decision).toBe("PROCEED");
    expect(r.chargeTo).toBe("MEMBER");
  });

  it("BLOCK behavior → BLOCK decision", () => {
    const r = computeOverage({
      ...over,
      overageBehavior: "BLOCK",
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
    });
    expect(r.decision).toBe("BLOCK");
    expect(r.chargeTo).toBeNull();
  });
});
