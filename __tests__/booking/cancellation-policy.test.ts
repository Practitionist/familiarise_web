/**
 * @jest-environment node
 */

/**
 * B1/#1499 — the refund policy a booking was sold under. The terms live in typed
 * versioned rows now, but the guarantee is the same one the Json snapshot gave: the
 * ladder that governs a booking is the one that was live when it was bought, and a
 * booking with no policy at all is governed by the platform defaults.
 *
 * #1500 — and a booking funded entirely by referral credit restores that credit in
 * full inside any partial tier, because the credits rail cannot pay a fraction. A 0%
 * tier still restores nothing.
 */

import {
  computeRefundPct,
  quoteBookingRefund,
  validateTierLadder,
  MAX_POLICY_TIERS,
  PLATFORM_DEFAULT_TIERS,
  PLATFORM_DEFAULT_TERMS,
  type CancellationPolicyTerms,
} from "@/lib/payments/operations/cancellation-policy";

function terms(
  overrides: Partial<CancellationPolicyTerms> = {},
): CancellationPolicyTerms {
  return { ...PLATFORM_DEFAULT_TERMS, ...overrides };
}

describe("computeRefundPct — platform default tiers", () => {
  it.each([
    [48, 100], // two days out → full refund
    [24, 100], // exactly at the 24h boundary → full refund
    [23.9, 50], // inside a day → half
    [2, 50], // exactly at the 2h boundary → half
    [1.5, 0], // inside two hours → nothing
    [0, 0], // at start time → nothing
  ])("%s hours before start → %s%%", (hours, pct) => {
    expect(computeRefundPct(null, hours, false)).toBe(pct);
  });

  it("refunds nothing after the booking started", () => {
    expect(computeRefundPct(null, -3, false)).toBe(0);
  });

  it("consultant-initiated always refunds 100%, even past start", () => {
    expect(computeRefundPct(null, 1, true)).toBe(100);
    expect(computeRefundPct(null, -3, true)).toBe(100);
  });

  it("a frozen ladder wins over whatever the defaults become later", () => {
    const generous = terms({
      policyId: "policy-1",
      source: "ORG",
      tiers: [{ hoursBefore: 0, refundPct: 100 }],
    });
    // 1 hour before start: platform default says 0, the buyer's frozen terms say
    // 100 — the version the booking cites governs.
    expect(computeRefundPct(generous, 1, false)).toBe(100);
    expect(PLATFORM_DEFAULT_TERMS.tiers).toEqual(PLATFORM_DEFAULT_TIERS);
  });
});

describe("validateTierLadder — the one ladder rule", () => {
  it.each([
    ["the platform ladder", PLATFORM_DEFAULT_TIERS, null],
    ["a single total rung", [{ hoursBefore: 0, refundPct: 50 }], null],
    ["an empty ladder", [], "A policy needs at least one tier"],
    [
      "too many rungs",
      Array.from({ length: MAX_POLICY_TIERS + 1 }, (_, i) => ({
        hoursBefore: MAX_POLICY_TIERS - i,
        refundPct: 0,
      })),
      `A policy may not have more than ${MAX_POLICY_TIERS} tiers`,
    ],
    [
      "a ladder that never reaches zero notice",
      [{ hoursBefore: 2, refundPct: 50 }],
      "The last tier must start at 0 hours so every cancellation is covered",
    ],
    [
      "two rungs at the same notice",
      [
        { hoursBefore: 0, refundPct: 50 },
        { hoursBefore: 0, refundPct: 10 },
      ],
      "Two tiers may not share the same notice period",
    ],
    [
      "a refund above 100%",
      [{ hoursBefore: 0, refundPct: 120 }],
      "Each tier's refund must be between 0 and 100 percent",
    ],
    [
      "three decimal places",
      [{ hoursBefore: 0, refundPct: 12.345 }],
      "A refund percentage may carry at most two decimal places",
    ],
    // #1513 review — `0.07 * 100` is 7.000000000000001 in IEEE 754, so the
    // exact-equality form of this check refused a legal two-decimal rung.
    [
      "two decimal places that float badly",
      [{ hoursBefore: 0, refundPct: 0.07 }],
      null,
    ],
    [
      "three decimal places below one percent",
      [{ hoursBefore: 0, refundPct: 0.075 }],
      "A refund percentage may carry at most two decimal places",
    ],
    [
      "fractional notice hours",
      [{ hoursBefore: 1.5, refundPct: 0 }],
      "Each tier's notice must be a whole number of hours, zero or more",
    ],
  ])("%s", (_label, tiers, expected) => {
    expect(validateTierLadder(tiers)).toBe(expected);
  });
});

describe("quoteBookingRefund — #1500 credit-funded bookings", () => {
  const base = {
    policy: null,
    hoursUntilNextSession: 3,
    slotsTotal: 1,
    sessionsRemaining: 1,
    isSubscription: false,
    isConsultantInitiated: false,
    grossPaise: 0,
    refundablePaise: 0,
  };

  it("restores the credit in full inside a partial tier", () => {
    // Three hours' notice is the 50% rung; a credit cannot be halved, so the whole
    // credit comes back and the quote says 100%.
    const quote = quoteBookingRefund({ ...base, isFreeCreditFunded: true });
    expect(quote.tierRefundPct).toBe(50);
    expect(quote.creditRestoresInFull).toBe(true);
    expect(quote.refundPct).toBe(100);
  });

  it("restores nothing inside the 0% tier", () => {
    const quote = quoteBookingRefund({
      ...base,
      hoursUntilNextSession: 1,
      isFreeCreditFunded: true,
    });
    expect(quote.tierRefundPct).toBe(0);
    expect(quote.creditRestoresInFull).toBe(false);
    expect(quote.refundPct).toBe(0);
  });

  it("leaves a money-funded booking on the tier percentage", () => {
    const quote = quoteBookingRefund({
      ...base,
      isFreeCreditFunded: false,
      grossPaise: 200_000,
      refundablePaise: 200_000,
    });
    expect(quote.creditRestoresInFull).toBe(false);
    expect(quote.refundPct).toBe(50);
    expect(quote.refundPaise).toBe(100_000);
  });
});

describe("quoteBookingRefund — #1766 unused sessions against the plan", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-09-20T10:00:00Z");
  const plan = (
    overrides: Partial<Parameters<typeof quoteBookingRefund>[0]> = {},
  ) =>
    quoteBookingRefund({
      policy: null,
      hoursUntilNextSession: null,
      slotsTotal: 0,
      sessionsRemaining: 0,
      isSubscription: true,
      isConsultantInitiated: false,
      isFreeCreditFunded: false,
      grossPaise: 12_000,
      refundablePaise: 12_000,
      sessionsTotal: 12,
      sessionsCompleted: 4,
      scheduledStarts: [NOW + 1 * HOUR],
      nowMs: NOW,
      ...overrides,
    });

  it("12-plan, 4 delivered, 1 scheduled in an hour: seven never-scheduled at 100%, the late one at 0%", () => {
    const quote = plan();
    expect(quote.refundPaise).toBe(7_000);
    expect(quote.tierRefundPct).toBe(0);
    expect(quote.prorated).toBe(true);
    expect(quote.proratedBasePaise).toBe(8_000);
    // 7 000 of the 8 000 undelivered base: the dialog shows one honest number.
    expect(quote.refundPct).toBe(87.5);
  });

  it("consultant-initiated pays every undelivered session in full", () => {
    expect(plan({ isConsultantInitiated: true }).refundPaise).toBe(8_000);
  });

  it("a never-scheduled session takes the ladder's infinite-notice rung, not a hardcoded 100%", () => {
    const strict = terms({
      policyId: "policy-strict",
      source: "ORG",
      tiers: [
        { hoursBefore: 72, refundPct: 80 },
        { hoursBefore: 0, refundPct: 10 },
      ],
      consultantInitiatedPct: 90,
    });
    // Seven never scheduled at the 80% top rung, one in an hour at 10%.
    expect(plan({ policy: strict }).refundPaise).toBe(5_600 + 100);
    expect(
      plan({ policy: strict, isConsultantInitiated: true }).refundPaise,
    ).toBe(7_200);
  });

  it("6 of 144 allocated, 3 delivered, 3 far out: 141 sessions come back, not half", () => {
    const quote = plan({
      grossPaise: 144_000,
      refundablePaise: 144_000,
      sessionsTotal: 144,
      sessionsCompleted: 3,
      scheduledStarts: [NOW + 72 * HOUR, NOW + 96 * HOUR, NOW + 120 * HOUR],
    });
    expect(quote.refundPaise).toBe(141_000);
    expect(quote.refundPct).toBe(100);
  });

  it("an untouched plan whose price does not divide still refunds the whole gross", () => {
    const quote = plan({
      grossPaise: 500_000,
      refundablePaise: 500_000,
      sessionsTotal: 3,
      sessionsCompleted: 0,
      scheduledStarts: [NOW + 72 * HOUR, NOW + 96 * HOUR, NOW + 120 * HOUR],
    });
    expect(quote.refundPaise).toBe(500_000);
    expect(quote.prorated).toBe(false);
  });

  it("clamps to the balance an earlier refund left", () => {
    expect(plan({ refundablePaise: 5_000 }).refundPaise).toBe(5_000);
  });

  it("falls back to the allocated-slot proration when the plan total is unknown", () => {
    const quote = plan({
      sessionsTotal: null,
      slotsTotal: 6,
      sessionsRemaining: 3,
      hoursUntilNextSession: 72,
    });
    expect(quote.refundPaise).toBe(6_000);
  });
});
