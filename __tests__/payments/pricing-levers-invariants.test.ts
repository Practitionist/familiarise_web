/**
 * @jest-environment node
 */

/**
 * Every pricing lever combination keeps the platform's margin non-negative and
 * never touches the expert's share: regime × rail × pre-tax modifier × credits.
 */

import { calculatePricing } from "@/app/checkout/plans/math";
import { deriveCheckoutAmount } from "@/lib/payments/pricing/derive-checkout-amount";
import {
  GATEWAY_COST_BPS,
  platformFundedCapPaise,
} from "@/lib/payments/pricing/platform-funded-cap";
import { prorate } from "@/lib/payments/utils/money";
import {
  assertOrgBillingAvailable,
  currentGstRegime,
  type GstRegime,
} from "@/lib/payments/tax/gst-regime";
import type { WelcomeDiscount } from "@/lib/referrals/promo-math";

delete process.env.PLATFORM_LUT_NUMBER;
delete process.env.PLATFORM_LUT_VALID_TILL;
delete process.env.PLATFORM_GSTIN;

/** What resolveCheckoutAttribution hands each rail (programme caps at 20%, ₹500). */
const RAILS = [
  { name: "marketplace", platformBps: 2000, orgBps: 0, fundsPromo: true },
  { name: "own-link", platformBps: 1000, orgBps: 0, fundsPromo: true },
  { name: "host-org", platformBps: 1000, orgBps: 1000, fundsPromo: false },
] as const;

const MODIFIERS = ["none", "percent-code", "fixed-code", "welcome"] as const;
const REGIMES: GstRegime[] = ["REGISTERED", "UNREGISTERED"];
const LISTS = [60_000, 100_000, 1_234_567];

const cases = REGIMES.flatMap((regime) =>
  RAILS.flatMap((rail) =>
    MODIFIERS.flatMap((modifier) =>
      [0, 10_000_000].flatMap((creditsPaise) =>
        LISTS.map((list) => ({ regime, rail, modifier, creditsPaise, list })),
      ),
    ),
  ),
);

describe("pricing levers invariants", () => {
  it.each(cases)(
    "$regime $rail.name $modifier credits=$creditsPaise list=$list",
    async ({ regime, rail, modifier, creditsPaise, list }) => {
      const promoFeeBps = rail.fundsPromo ? rail.platformBps : 0;
      const welcome: WelcomeDiscount | null =
        modifier === "welcome" && rail.fundsPromo
          ? { bps: rail.platformBps, maxPaise: 50_000, minOrderPaise: 0 }
          : null;
      const discount =
        modifier === "percent-code"
          ? { discountType: "PERCENTAGE" as const, discountValue: 25 }
          : modifier === "fixed-code"
            ? { discountType: "FIXED_AMOUNT" as const, discountValue: 30_000 }
            : null;
      const creditCapBps = rail.fundsPromo ? rail.platformBps : 0;

      const d = await deriveCheckoutAmount({
        basePaise: list,
        buyerCountry: "IN",
        gstRegime: regime,
        discount,
        welcomeDiscount: welcome,
        creditCapBps,
        promoFeeBps,
        useReferralCredits: creditsPaise > 0,
        resolveAvailableCreditsPaise: () => creditsPaise,
      });

      // Settlement reads the earnings base: the fee and the expert's share come off it.
      const settle = (gross: number) => {
        const fee = prorate(gross, rail.platformBps, 10_000);
        const expertBps = 10_000 - rail.platformBps - rail.orgBps;
        const expert =
          rail.orgBps > 0 ? prorate(gross, expertBps, 10_000) : gross - fee;
        return { fee, expert, org: gross - fee - expert };
      };
      const shares = settle(d.originalAmount);
      const gatewayPaise = prorate(d.amount, GATEWAY_COST_BPS, 10_000, "ceil");
      const platformNet =
        d.amount - d.taxAmount - shares.expert - shares.org - gatewayPaise;

      expect(platformNet).toBeGreaterThanOrEqual(0);
      expect(shares).toEqual(settle(list));
      expect(d.amount).toBe(d.taxedAmount - d.creditsApplied);
      expect(d.discountedAmount).toBe(list - d.discountPaise);
      expect(d.discountPaise + d.creditsApplied).toBeLessThanOrEqual(
        platformFundedCapPaise({
          listPaise: list,
          platformFeeBps: promoFeeBps,
          gstRegistered: regime === "REGISTERED",
        }),
      );
      expect(d.taxAmount).toBe(
        regime === "REGISTERED"
          ? prorate(list - d.discountPaise, 18, 100, "round")
          : 0,
      );

      // The checkout preview quotes the server's total (it keeps two decimals of a paise).
      const preview = calculatePricing(list, {
        discountPercent: discount?.discountType === "PERCENTAGE" ? 0.25 : 0,
        discountAmount:
          discount?.discountType === "FIXED_AMOUNT"
            ? discount.discountValue
            : undefined,
        creditsApplied: creditsPaise,
        welcomeDiscount: welcome,
        creditCapBps,
        promoFeeBps,
        gstRegistered: regime === "REGISTERED",
      });
      expect(Math.abs(preview.total - d.amount)).toBeLessThanOrEqual(1);
    },
  );

  it("derives the regime from PLATFORM_GSTIN and fails closed on a bad one", () => {
    expect(currentGstRegime()).toBe("UNREGISTERED");
    expect(() => assertOrgBillingAvailable("UNREGISTERED")).toThrow(
      expect.objectContaining({ code: "GST_REGISTRATION_REQUIRED" }),
    );
    process.env.PLATFORM_GSTIN = "29ABCDE1234F1Z5";
    try {
      expect(() => currentGstRegime()).toThrow(
        expect.objectContaining({ code: "GST_CONFIG_INVALID" }),
      );
    } finally {
      delete process.env.PLATFORM_GSTIN;
    }
  });

  it("prices the ₹1,000 marketplace referral order of the decision record", async () => {
    const d = await deriveCheckoutAmount({
      basePaise: 100_000,
      buyerCountry: "IN",
      gstRegime: "REGISTERED",
      welcomeDiscount: { bps: 2000, maxPaise: 50_000, minOrderPaise: 0 },
      creditCapBps: 2000,
      promoFeeBps: 2000,
    });
    expect(d).toMatchObject({
      platformFundedCapPaise: 17_215,
      welcomeDiscountPaise: 17_215,
      taxAmount: 14_901,
      amount: 97_686,
    });
  });
});
