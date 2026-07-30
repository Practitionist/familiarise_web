/**
 * @jest-environment node
 */

/**
 * Two gates that decide real money, both of which were open.
 *
 * 1. INR-only settlement. The platform settles in INR end to end — Razorpay
 *    always settles INR, and the double-entry ledger is INR-denominated (#783).
 *    `validatePlanCurrency` enforces that, and it had exactly one call site:
 *    the direct-checkout path. The request→approve path never called it, so a
 *    consultant who priced a plan in GBP (the planner's currency dropdown
 *    offered INR/USD/EUR/GBP) took a real GBP charge through Stripe. Every
 *    stage below then read that pence figure as INR paise: the earnings row
 *    hardcodes "INR", the journal posts into an INR account, and the payout is
 *    sized off it. It balances, and it reconciles clean, because nothing
 *    compares an amount against its own currency.
 *
 * 2. Buyer country, which decides GST. `Accept-Language` used to be a tax
 *    signal, and in this deployment it was THE tax signal: `User.country` is
 *    free text that can never satisfy the `.length === 2` check, and
 *    `cf-ipcountry` never arrives because production is Netlify with no
 *    Cloudflare. So `en-US` — a common browser default in India — zero-rated
 *    domestic sales as exports.
 */

import { detectBuyerCountry } from "../../lib/payments/tax/buyer-country";
import { validatePlanCurrency } from "../../lib/payments/validation/currency-guards";

describe("buyer country never zero-rates on a browser locale", () => {
  it("ignores Accept-Language entirely, even when it names a country", () => {
    // The exact production shape: no usable profile country, no Cloudflare.
    expect(
      detectBuyerCountry({
        userCountry: null,
        cfIpCountry: null,
        acceptLanguage: "en-US,en;q=0.9",
      }),
    ).toBe("IN");
  });

  it("does not let a free-text country name through either", () => {
    // Onboarding collects "e.g., United States" as plain text. It must not be
    // mistaken for an ISO code, and must not silently zero-rate.
    expect(
      detectBuyerCountry({
        userCountry: "United States",
        cfIpCountry: null,
        acceptLanguage: "en-US",
      }),
    ).toBe("IN");
  });

  it("still honours an explicit two-letter profile country", () => {
    // The one signal a person actually asserted.
    expect(
      detectBuyerCountry({ userCountry: "gb", acceptLanguage: "en-IN" }),
    ).toBe("GB");
  });

  it("still honours a real geo-IP header if one is ever put in front", () => {
    expect(
      detectBuyerCountry({ cfIpCountry: "DE", acceptLanguage: "en-US" }),
    ).toBe("DE");
  });

  it("defaults to IN when nothing is known", () => {
    // Over-collecting GST is recoverable; under-collecting is a liability.
    expect(detectBuyerCountry({})).toBe("IN");
  });
});

describe("only INR plans can reach a charge", () => {
  it("accepts INR", () => {
    expect(() => validatePlanCurrency("INR")).not.toThrow();
  });

  it.each(["USD", "EUR", "GBP"])("rejects %s", (ccy) => {
    expect(() => validatePlanCurrency(ccy as never)).toThrow();
  });

  it("is called by the approval-payment path, not only by direct checkout", () => {
    // A behavioural test would need the whole booking graph; this asserts the
    // call site exists, which is the thing that regressed. Both branches of
    // calculateAmount (CONSULTATION and SUBSCRIPTION) must be covered.
    const src = require("fs").readFileSync(
      require("path").join(
        process.cwd(),
        "lib/payments/operations/approval-payment.ts",
      ),
      "utf8",
    );
    const calls = src.match(/validatePlanCurrency\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the planner cannot create an unsettleable plan", () => {
  it("offers INR only", () => {
    const src = require("fs").readFileSync(
      require("path").join(
        process.cwd(),
        "components/planner/components/form-fields/PriceField.tsx",
      ),
      "utf8",
    );
    const match = src.match(/const DEFAULT_CURRENCIES = (\[[^\]]*\])/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1].replace(/'/g, '"'))).toEqual(["INR"]);
  });
});
