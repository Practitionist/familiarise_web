/**
 * @jest-environment node
 */

/**
 * Property tests for the pure money helpers: splits sum to the total, a run of
 * partial refunds never returns more than was paid, and the final remainder
 * refund lands exactly on the paid amount. Only functions with no database
 * access are covered; see the money-races suite for the CAS-guarded paths.
 */

import fc from "fast-check";
import { prorate, splitByBps, sumPaise } from "../../lib/payments/utils/money";
import { deriveGstBreakdown } from "../../lib/compliance/gst";
import {
  computeOverage,
  type OverageInput,
} from "../../lib/payments/billing/overage";
import {
  allocateCycleClawback,
  type ClawbackRow,
} from "../../lib/payments/payouts/earnings-reversal";
import { refundableBalancePaise } from "../../lib/payments/refundable-balance";
import {
  PLATFORM_DEFAULT_TERMS,
  computeRefundPct,
  quoteBookingRefund,
  quoteClassSeatRefund,
  tiersFromBps,
  type CancellationPolicyTerms,
} from "../../lib/payments/operations/cancellation-policy";

const CONFIG = { seed: 2230, numRuns: 200 };

const MAX_PAISE = 10_000_000_000;
/** prorate() multiplies in doubles, so it is exact only while a * n stays below 2^53. */
const SAFE_FACTOR_MAX = 90_000_000;

const totalPaise = fc.integer({ min: 0, max: MAX_PAISE });

/** A partition of 10000 bps into 1..6 parts (zero-bps parts allowed). */
const bpsPartition = fc
  .array(fc.integer({ min: 0, max: 10_000 }), { minLength: 0, maxLength: 5 })
  .map((cuts) => {
    const sorted = [...cuts].sort((a, b) => a - b);
    const parts: number[] = [];
    let prev = 0;
    for (const cut of sorted) {
      parts.push(cut - prev);
      prev = cut;
    }
    parts.push(10_000 - prev);
    return parts;
  });

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("splitByBps", () => {
  it("parts sum exactly to the total, are non-negative, and the last part absorbs the remainder", () => {
    fc.assert(
      fc.property(totalPaise, bpsPartition, (total, bps) => {
        const last = bps.length - 1;
        const shares = splitByBps(total, bps, last);
        expect(shares).toHaveLength(bps.length);
        expect(sum(shares)).toBe(total);
        shares.forEach((s) => {
          expect(Number.isInteger(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
        });
        for (let i = 0; i < last; i++) {
          expect(shares[i]).toBe(Math.floor((total * bps[i]) / 10_000));
        }
        const flooredLast = Math.floor((total * bps[last]) / 10_000);
        expect(shares[last]).toBeGreaterThanOrEqual(flooredLast);
        expect(shares[last] - flooredLast).toBeLessThan(bps.length);
      }),
      CONFIG,
    );
  });

  it("any residual index absorbs the remainder and the split still sums to the total", () => {
    fc.assert(
      fc.property(totalPaise, bpsPartition, fc.nat(), (total, bps, pick) => {
        const residual = pick % bps.length;
        const shares = splitByBps(total, bps, residual);
        expect(sum(shares)).toBe(total);
        shares.forEach((s) => expect(s).toBeGreaterThanOrEqual(0));
        expect(shares.filter((_, i) => i !== residual)).toEqual(
          bps
            .filter((_, i) => i !== residual)
            .map((b) => Math.floor((total * b) / 10_000)),
        );
      }),
      CONFIG,
    );
  });

  it("leaves the unallocated remainder with the caller when the shares sum under 10000 bps", () => {
    fc.assert(
      fc.property(
        totalPaise,
        bpsPartition,
        fc.integer({ min: 1, max: 10_000 }),
        (total, bps, hold) => {
          // Shave `hold` bps off the partition so the shares total less than the whole.
          const shaved = [...bps];
          let left = hold;
          for (let i = shaved.length - 1; i >= 0 && left > 0; i--) {
            const take = Math.min(shaved[i], left);
            shaved[i] -= take;
            left -= take;
          }
          const shares = splitByBps(total, shaved, 0);
          expect(sum(shares)).toBeLessThanOrEqual(total);
          shares.forEach((s, i) => {
            expect(s).toBe(Math.floor((total * shaved[i]) / 10_000));
          });
        },
      ),
      CONFIG,
    );
  });

  it("refuses shares above 10000 bps and an out-of-range residual index", () => {
    fc.assert(
      fc.property(
        totalPaise,
        fc.integer({ min: 10_001, max: 20_000 }),
        (total, over) => {
          expect(() => splitByBps(total, [over], 0)).toThrow(
            /exceeds the whole/,
          );
          expect(() => splitByBps(total, [5_000, 5_000], 2)).toThrow(
            /out of range/,
          );
        },
      ),
      CONFIG,
    );
  });
});

describe("prorate", () => {
  const factor = fc.integer({ min: 1, max: SAFE_FACTOR_MAX });

  it("equals the exact integer floor of amount * num / den while the product is a safe integer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SAFE_FACTOR_MAX }),
        factor,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (amount, den, frac) => {
          const num = Math.floor(den * frac);
          const exact = Number((BigInt(amount) * BigInt(num)) / BigInt(den));
          expect(prorate(amount, num, den)).toBe(exact);
          expect(prorate(amount, num, den)).toBeLessThanOrEqual(amount);
          expect(prorate(amount, den, den)).toBe(amount);
          expect(prorate(amount, 0, den)).toBe(0);
        },
      ),
      CONFIG,
    );
  });

  it("floored shares of a partition sum to at most the amount, and the residual party takes the rest", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SAFE_FACTOR_MAX }),
        fc.array(fc.integer({ min: 1, max: 1_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (amount, weights) => {
          const den = sum(weights);
          const shares = weights.map((w) => prorate(amount, w, den));
          const assigned = sum(shares);
          expect(assigned).toBeLessThanOrEqual(amount);
          expect(amount - assigned).toBeLessThan(weights.length);
          shares[0] += amount - assigned;
          expect(sum(shares)).toBe(amount);
          shares.forEach((s) => expect(s).toBeGreaterThanOrEqual(0));
        },
      ),
      CONFIG,
    );
  });

  it("rejects a non-positive denominator", () => {
    expect(() => prorate(100, 1, 0)).toThrow(/non-positive denominator/);
    expect(() => prorate(100, 1, -5)).toThrow(/non-positive denominator/);
  });

  // The double product loses integer precision above 2^53, so a full-amount
  // proration at 1e10 paise can come back one paisa short. Real bug, left unfixed here.
  it.failing(
    "returns the whole amount when the numerator equals the denominator across the full paise range",
    () => {
      expect(prorate(416_029_418, 2_869_922_706, 2_869_922_706)).toBe(
        416_029_418,
      );
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: MAX_PAISE }),
          fc.integer({ min: 1, max: MAX_PAISE }),
          (amount, den) => {
            expect(prorate(amount, den, den)).toBe(amount);
          },
        ),
        CONFIG,
      );
    },
  );
});

describe("sumPaise", () => {
  it("is the identity on safe integers and refuses anything beyond the safe range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_PAISE }), (n) => {
        expect(sumPaise(n)).toBe(n);
        expect(sumPaise(BigInt(n))).toBe(n);
      }),
      CONFIG,
    );
    expect(() => sumPaise(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2))).toThrow(
      /safe range/,
    );
    expect(sumPaise(null)).toBe(0);
    expect(sumPaise(undefined)).toBe(0);
  });
});

describe("deriveGstBreakdown", () => {
  const stateCodes = fc.constantFrom("27", "29", "07", "33", null);

  it("heads always sum to the tax, the total nets, CGST floors and SGST absorbs the odd paisa", () => {
    fc.assert(
      fc.property(
        totalPaise,
        stateCodes,
        stateCodes,
        (subtotal, supplier, buyer) => {
          const gst = deriveGstBreakdown({
            subtotalPaise: subtotal,
            supplierStateCode: supplier,
            buyerStateCode: buyer,
            buyerCountry: "IN",
          });
          const exactTax = Number(
            (BigInt(subtotal) * BigInt(18) + BigInt(50)) / BigInt(100),
          );
          const heads = gst.igstPaise + gst.cgstPaise + gst.sgstPaise;
          expect(heads).toBe(exactTax);
          expect(gst.totalPaise).toBe(subtotal + heads);
          expect(gst.subtotalPaise).toBe(subtotal);
          [gst.igstPaise, gst.cgstPaise, gst.sgstPaise].forEach((h) =>
            expect(h).toBeGreaterThanOrEqual(0),
          );
          const intra = gst.reason === "INTRA_STATE_CGST_SGST";
          const cgst = Math.floor(exactTax / 2);
          expect(gst.igstPaise).toBe(intra ? 0 : exactTax);
          expect(gst.cgstPaise).toBe(intra ? cgst : 0);
          expect(gst.sgstPaise).toBe(intra ? exactTax - cgst : 0);
        },
      ),
      CONFIG,
    );
  });

  it("splits a caller-supplied tax across the heads without levying it again", () => {
    fc.assert(
      fc.property(totalPaise, totalPaise, (subtotal, tax) => {
        const gst = deriveGstBreakdown({
          subtotalPaise: subtotal,
          taxPaise: tax,
          supplierStateCode: "29",
          buyerStateCode: "29",
          buyerCountry: "IN",
        });
        expect(gst.cgstPaise + gst.sgstPaise).toBe(tax);
        expect(gst.sgstPaise - gst.cgstPaise).toBeLessThanOrEqual(1);
        expect(gst.sgstPaise - gst.cgstPaise).toBeGreaterThanOrEqual(0);
        expect(gst.totalPaise).toBe(subtotal + tax);
      }),
      CONFIG,
    );
  });
});

describe("computeOverage", () => {
  const behavior = fc.constantFrom(
    "BLOCK",
    "CHARGE_MEMBER",
    "CHARGE_ORG",
  ) as fc.Arbitrary<OverageInput["overageBehavior"]>;
  const optionalPaise = fc.option(fc.integer({ min: 0, max: 100_000_000 }), {
    nil: null,
  });

  const overageInput: fc.Arbitrary<OverageInput> = fc
    .record({
      programType: fc.constantFrom("LICENSED_SEAT", "CREDIT_POOL"),
      bookingPricePaise: fc.integer({ min: 0, max: 100_000_000 }),
      engagementsConsumed: fc.integer({ min: 1, max: 12 }),
      overageBehavior: behavior,
      maxOveragePerCyclePaise: optionalPaise,
      cycleOverageSoFarPaise: fc.integer({ min: 0, max: 100_000_000 }),
      overageSurchargeBps: fc.option(fc.integer({ min: 0, max: 10_000 }), {
        nil: null,
      }),
      coveredEngagementsPerCycle: fc.option(fc.integer({ min: 0, max: 20 }), {
        nil: null,
      }),
      engagementsUsed: fc.integer({ min: 0, max: 30 }),
      priceCapPerEngagementPaise: optionalPaise,
      creditBudgetPaise: optionalPaise,
      consumedPaise: fc.integer({ min: 0, max: 100_000_000 }),
    })
    .map((r) => r as OverageInput);

  it("covered + base equals the price, marginal equals base + floored surcharge, nothing is negative", () => {
    fc.assert(
      fc.property(overageInput, (input) => {
        const out = computeOverage(input);
        const price = Math.max(0, Math.floor(input.bookingPricePaise));
        expect(out.coveredPaise + out.basePaise).toBe(price);
        expect(out.marginalPaise).toBe(out.basePaise + out.surchargePaise);
        [out.coveredPaise, out.basePaise, out.surchargePaise].forEach((v) =>
          expect(v).toBeGreaterThanOrEqual(0),
        );
        expect(out.basePaise).toBeLessThanOrEqual(price);
        const bps = input.overageSurchargeBps ?? 0;
        const expectedSurcharge =
          out.basePaise > 0 && bps > 0
            ? Math.floor((out.basePaise * bps) / 10_000)
            : 0;
        expect(out.surchargePaise).toBe(expectedSurcharge);
      }),
      CONFIG,
    );
  });

  it("blocks past the per-cycle ceiling and never charges anyone when it blocks", () => {
    fc.assert(
      fc.property(overageInput, (input) => {
        const out = computeOverage(input);
        const overCeiling =
          out.marginalPaise > 0 &&
          input.maxOveragePerCyclePaise !== null &&
          input.cycleOverageSoFarPaise + out.marginalPaise >
            input.maxOveragePerCyclePaise;
        const blocked = out.decision === "BLOCK";
        const free = out.marginalPaise === 0;
        // Each line reads "if the premise holds, the conclusion must".
        expect(!overCeiling || blocked).toBe(true);
        expect(!blocked || out.chargeTo === null).toBe(true);
        expect(
          !free || (out.decision === "PROCEED" && out.chargeTo === null),
        ).toBe(true);
      }),
      CONFIG,
    );
  });
});

describe("allocateCycleClawback", () => {
  const statuses = ["PENDING", "READY", "HELD", "BATCHED", "PAID", "REFUNDED"];
  const clawbackRows = fc
    .array(
      fc.record({
        share: fc.integer({ min: 0, max: 1_000_000 }),
        refundedFrac: fc.double({ min: 0, max: 1, noNaN: true }),
        status: fc.constantFrom(...statuses),
        undelivered: fc.boolean(),
        ordinal: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
      }),
      { minLength: 0, maxLength: 10 },
    )
    .map((rs): ClawbackRow[] =>
      rs.map((r, i) => ({
        id: `r${i}`,
        cycleOrdinal: r.ordinal,
        consultantSharePaise: r.share,
        refundedShareAmount: Math.floor(r.share * r.refundedFrac),
        status: r.status,
        holdUntil: r.undelivered ? null : new Date("2026-01-01T00:00:00Z"),
      })),
    );

  it("absorbs the whole clawback up to what the rows still hold, never more than a row's capacity, never into REFUNDED rows", () => {
    fc.assert(
      fc.property(
        clawbackRows,
        fc.integer({ min: -1_000, max: 5_000_000 }),
        (rows, clawback) => {
          const out = allocateCycleClawback(rows, clawback);
          const byId = new Map(rows.map((r) => [r.id, r]));
          const capacity = sum(
            rows
              .filter((r) => r.status !== "REFUNDED")
              .map((r) =>
                Math.max(0, r.consultantSharePaise - r.refundedShareAmount),
              ),
          );
          expect(new Set(out.map((a) => a.id)).size).toBe(out.length);
          out.forEach((a) => {
            const row = byId.get(a.id);
            expect(row).toBeDefined();
            expect(row?.status).not.toBe("REFUNDED");
            expect(a.absorbPaise).toBeGreaterThan(0);
            expect(a.absorbPaise).toBeLessThanOrEqual(
              (row?.consultantSharePaise ?? 0) -
                (row?.refundedShareAmount ?? 0),
            );
          });
          expect(sum(out.map((a) => a.absorbPaise))).toBe(
            Math.min(Math.max(0, clawback), capacity),
          );
        },
      ),
      CONFIG,
    );
  });

  it("touches a PAID row only once every undelivered, running and batched row is exhausted", () => {
    fc.assert(
      fc.property(
        clawbackRows,
        fc.integer({ min: 0, max: 5_000_000 }),
        (rows, clawback) => {
          const out = allocateCycleClawback(rows, clawback);
          const absorbed = new Map(out.map((a) => [a.id, a.absorbPaise]));
          const paidTouched = rows.some(
            (r) => r.status === "PAID" && absorbed.has(r.id),
          );
          if (!paidTouched) return;
          rows
            .filter((r) => r.status !== "PAID" && r.status !== "REFUNDED")
            .forEach((r) => {
              const cap = Math.max(
                0,
                r.consultantSharePaise - r.refundedShareAmount,
              );
              expect(absorbed.get(r.id) ?? 0).toBe(cap);
            });
        },
      ),
      CONFIG,
    );
  });
});

describe("computeRefundPct", () => {
  const ladder = fc
    .uniqueArray(fc.integer({ min: 1, max: 336 }), {
      minLength: 0,
      maxLength: 5,
    })
    .chain((hours) =>
      fc
        .array(fc.integer({ min: 0, max: 10_000 }), {
          minLength: hours.length + 1,
          maxLength: hours.length + 1,
        })
        .map((bps) =>
          tiersFromBps([
            ...hours.map((h, i) => ({ hoursBefore: h, refundBps: bps[i] })),
            { hoursBefore: 0, refundBps: bps[hours.length] },
          ]),
        ),
    );

  it("answers a rung of the ladder, a percentage within 0..100, and the consultant percentage when the expert cancels", () => {
    fc.assert(
      fc.property(
        ladder,
        fc.integer({ min: 0, max: 10_000 }),
        fc.double({ min: -50, max: 1_000, noNaN: true }),
        fc.boolean(),
        (tiers, consultantBps, hours, byConsultant) => {
          const terms: CancellationPolicyTerms = {
            ...PLATFORM_DEFAULT_TERMS,
            tiers,
            consultantInitiatedPct: consultantBps / 100,
          };
          const pct = computeRefundPct(terms, hours, byConsultant);
          expect(pct).toBeGreaterThanOrEqual(0);
          expect(pct).toBeLessThanOrEqual(100);
          const allowed = byConsultant
            ? [consultantBps / 100]
            : [0, ...tiers.map((t) => t.refundPct)];
          expect(allowed).toContain(pct);
        },
      ),
      CONFIG,
    );
  });
});

type ReturnedRefund = { amountPaise: number; status: string };

describe("refundableBalancePaise", () => {
  const refund = fc.record({
    amountPaise: fc.integer({ min: 0, max: 1_000_000_000 }),
    status: fc.constantFrom("SUCCEEDED", "PENDING", "FAILED", "CANCELLED"),
  });
  const dispute = fc.record({
    amountPaise: fc.integer({ min: 0, max: 1_000_000_000 }),
    status: fc.constantFrom("LOST", "CHARGE_REFUNDED", "NEEDS_RESPONSE", "WON"),
  });

  it("is gross less money already returned, floored at zero, ignoring refunds that moved no money", () => {
    fc.assert(
      fc.property(
        totalPaise,
        fc.array(refund, { maxLength: 8 }),
        fc.array(dispute, { maxLength: 4 }),
        (gross, refunds, disputes) => {
          const out = refundableBalancePaise(gross, { refunds, disputes });
          const returned =
            sum(
              refunds
                .filter(
                  (r) => r.status === "SUCCEEDED" || r.status === "PENDING",
                )
                .map((r) => r.amountPaise),
            ) +
            sum(
              disputes
                .filter(
                  (d) => d.status === "LOST" || d.status === "CHARGE_REFUNDED",
                )
                .map((d) => d.amountPaise),
            );
          expect(out).toBe(Math.max(0, gross - returned));
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(gross);
        },
      ),
      CONFIG,
    );
  });
});

describe("sequences of partial refunds", () => {
  const terms = fc
    .record({
      hours: fc.uniqueArray(fc.integer({ min: 1, max: 200 }), {
        minLength: 0,
        maxLength: 3,
      }),
      bps: fc.array(fc.integer({ min: 0, max: 10_000 }), {
        minLength: 4,
        maxLength: 4,
      }),
      consultantBps: fc.integer({ min: 0, max: 10_000 }),
    })
    .map(({ hours, bps, consultantBps }): CancellationPolicyTerms => ({
      ...PLATFORM_DEFAULT_TERMS,
      tiers: tiersFromBps([
        ...hours.map((h, i) => ({ hoursBefore: h, refundBps: bps[i] })),
        { hoursBefore: 0, refundBps: bps[3] },
      ]),
      consultantInitiatedPct: consultantBps / 100,
    }));

  const attempt = fc.record({
    policy: terms,
    hoursUntilNextSession: fc.option(
      fc.double({ min: -5, max: 400, noNaN: true }),
      {
        nil: null,
      },
    ),
    slotsTotal: fc.integer({ min: 0, max: 12 }),
    sessionsRemainingFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    isSubscription: fc.boolean(),
    isConsultantInitiated: fc.boolean(),
    isFreeCreditFunded: fc.boolean(),
    outcome: fc.constantFrom("SUCCEEDED", "SUCCEEDED", "PENDING", "FAILED"),
  });

  it("the cumulative refunded never exceeds the captured amount, and the remainder refund lands exactly on it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_PAISE }),
        fc.array(attempt, { minLength: 1, maxLength: 8 }),
        (gross, attempts) => {
          const refunds: ReturnedRefund[] = [];
          let moved = 0;
          for (const a of attempts) {
            const refundable = refundableBalancePaise(gross, {
              refunds,
              disputes: [],
            });
            const quote = quoteBookingRefund({
              policy: a.policy,
              hoursUntilNextSession: a.hoursUntilNextSession,
              slotsTotal: a.slotsTotal,
              sessionsRemaining: Math.floor(
                a.slotsTotal * a.sessionsRemainingFrac,
              ),
              isSubscription: a.isSubscription,
              isConsultantInitiated: a.isConsultantInitiated,
              isFreeCreditFunded: a.isFreeCreditFunded,
              grossPaise: gross,
              refundablePaise: refundable,
            });
            expect(quote.refundPaise).toBeGreaterThanOrEqual(0);
            expect(quote.refundPaise).toBeLessThanOrEqual(refundable);
            expect(quote.refundPaise).toBeLessThanOrEqual(
              quote.proratedBasePaise,
            );
            expect(quote.proratedBasePaise).toBeLessThanOrEqual(gross);
            if (quote.refundPaise > 0) {
              refunds.push({
                amountPaise: quote.refundPaise,
                status: a.outcome,
              });
              if (a.outcome !== "FAILED") moved += quote.refundPaise;
            }
            expect(moved).toBeLessThanOrEqual(gross);
          }
          const remainder = refundableBalancePaise(gross, {
            refunds,
            disputes: [],
          });
          expect(remainder).toBe(gross - moved);
          refunds.push({ amountPaise: remainder, status: "SUCCEEDED" });
          expect(
            sum(
              refunds
                .filter((r) => r.status !== "FAILED")
                .map((r) => r.amountPaise),
            ),
          ).toBe(gross);
          expect(refundableBalancePaise(gross, { refunds, disputes: [] })).toBe(
            0,
          );
        },
      ),
      CONFIG,
    );
  });

  it("a subscription cancelled before any session is delivered or scheduled refunds the whole gross at the default ladder", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_PAISE }),
        fc.integer({ min: 1, max: 200 }),
        (gross, sessionsTotal) => {
          const quote = quoteBookingRefund({
            policy: null,
            hoursUntilNextSession: null,
            slotsTotal: 0,
            sessionsRemaining: sessionsTotal,
            isSubscription: true,
            isConsultantInitiated: false,
            isFreeCreditFunded: false,
            grossPaise: gross,
            refundablePaise: gross,
            sessionsTotal,
            sessionsCompleted: 0,
            scheduledStarts: [],
          });
          expect(quote.refundPaise).toBe(gross);
        },
      ),
      CONFIG,
    );
  });

  it("a subscription refund stays within the gross, the refundable balance and the undelivered share", () => {
    const NOW = Date.parse("2026-06-01T00:00:00Z");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_PAISE }),
        fc.integer({ min: 1, max: 60 }),
        fc.nat(),
        fc.array(fc.integer({ min: -48, max: 24 * 60 }), { maxLength: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        terms,
        (
          gross,
          sessionsTotal,
          completedPick,
          startHours,
          refundableFrac,
          policy,
        ) => {
          const sessionsCompleted = completedPick % (sessionsTotal + 1);
          const refundable = Math.floor(gross * refundableFrac);
          const quote = quoteBookingRefund({
            policy,
            hoursUntilNextSession: null,
            slotsTotal: startHours.length,
            sessionsRemaining: sessionsTotal - sessionsCompleted,
            isSubscription: true,
            isConsultantInitiated: false,
            isFreeCreditFunded: false,
            grossPaise: gross,
            refundablePaise: refundable,
            sessionsTotal,
            sessionsCompleted,
            scheduledStarts: startHours.map((h) => NOW + h * 3_600_000),
            nowMs: NOW,
          });
          expect(quote.refundPaise).toBeGreaterThanOrEqual(0);
          expect(quote.refundPaise).toBeLessThanOrEqual(refundable);
          expect(quote.refundPaise).toBeLessThanOrEqual(
            quote.proratedBasePaise,
          );
          expect(quote.proratedBasePaise).toBeLessThanOrEqual(gross);
        },
      ),
      CONFIG,
    );
  });

  it("class-seat refunds never pay more than the unit price of the sessions still owed, across repeated leaves", () => {
    const NOW = Date.parse("2026-06-01T00:00:00Z");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.array(fc.integer({ min: -24, max: 24 * 30 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 8 }),
        fc.array(
          fc.record({
            nowShiftHours: fc.integer({ min: 0, max: 24 * 10 }),
            refundableFrac: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        terms,
        (unit, startHours, neverScheduled, steps, policy) => {
          const sessions = startHours.length + neverScheduled;
          let cumulative = 0;
          for (const step of steps) {
            const refundable = Math.floor(
              unit * sessions * step.refundableFrac,
            );
            const quote = quoteClassSeatRefund({
              policy,
              isConsultantInitiated: false,
              unitPaise: BigInt(unit),
              remainingStartsMs: startHours.map((h) => NOW + h * 3_600_000),
              neverScheduled,
              alreadyRefundedPaise: cumulative,
              refundablePaise: refundable,
              nowMs: NOW + step.nowShiftHours * 3_600_000,
            });
            expect(quote.refundPaise).toBeGreaterThanOrEqual(0);
            expect(quote.refundPaise).toBeLessThanOrEqual(refundable);
            cumulative += quote.refundPaise;
            expect(cumulative).toBeLessThanOrEqual(unit * sessions);
          }
        },
      ),
      CONFIG,
    );
  });

  it("per-refund clawback prorations never claw back more than the earning's share, and the share is never overdrawn by the last refund", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: SAFE_FACTOR_MAX }),
        fc.array(fc.integer({ min: 1, max: 1_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: 0, max: SAFE_FACTOR_MAX }),
        (payment, weights, share) => {
          const den = Math.min(payment, SAFE_FACTOR_MAX);
          const totalWeight = sum(weights);
          // Split the payment into refunds proportional to the weights; the last takes the remainder.
          const refunds = weights.map((w) =>
            Math.floor((den * w) / totalWeight),
          );
          refunds[refunds.length - 1] += den - sum(refunds);
          expect(sum(refunds)).toBe(den);
          const claws = refunds.map((r) =>
            prorate(Math.min(share, den), r, den),
          );
          expect(sum(claws)).toBeLessThanOrEqual(Math.min(share, den));
        },
      ),
      CONFIG,
    );
  });
});
