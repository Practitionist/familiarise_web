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
import {
  assertInrSettlement,
  validatePlanCurrency,
} from "../../lib/payments/validation/currency-guards";

// #1396 — the Razorpay SDK is replaced wholesale so `createRazorpayOrder` can be
// called for real and the assertion observed at its true position: ahead of the
// client lookup and ahead of `orders.create`. Asserting that the spy was never
// called is the whole point — a guard placed after the SDK call would still
// throw and would still pass a naive "it throws" test.
const ordersCreate = jest.fn();
jest.mock("razorpay", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    orders: { create: (...args: unknown[]) => ordersCreate(...args) },
  })),
}));

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

describe("settlement is INR at the gateway boundary (#1396)", () => {
  it("passes INR through", () => {
    expect(() =>
      assertInrSettlement("INR", "create a test order"),
    ).not.toThrow();
  });

  it("normalises before deciding, so lower case and padding still pass, and hands back the canonical code", () => {
    let result: string | undefined;
    expect(() => {
      result = assertInrSettlement(" inr ", "create a test order");
    }).not.toThrow();
    expect(result).toBe("INR");
  });

  it.each(["USD", "EUR", "GBP", "AED"])(
    "refuses %s with NON_INR_SETTLEMENT",
    (ccy) => {
      expect(() => assertInrSettlement(ccy, "create a test order")).toThrow(
        expect.objectContaining({ code: "NON_INR_SETTLEMENT" }),
      );
    },
  );

  it("refuses a code the platform cannot even represent", () => {
    // A currency outside the Prisma enum must fail the same way as a
    // representable-but-unsettleable one: both are non-INR settlement attempts.
    expect(() => assertInrSettlement("XYZ", "create a test order")).toThrow(
      expect.objectContaining({ code: "NON_INR_SETTLEMENT" }),
    );
  });

  it("stops a non-INR createRazorpayOrder before the SDK is called", async () => {
    // The reachable repro: a BillingAccount set to USD, whose currency the
    // wallet top-up route forwarded verbatim alongside an amount in INR paise.
    // Razorpay reads a non-INR amount in the target currency's own subunit, so
    // 100000 would have been a $1,000.00 order for an intended ₹1,000 top-up.
    process.env.RAZORPAY_KEY_ID ||= "rzp_test_stub";
    process.env.RAZORPAY_SECRET ||= "stub_secret";
    const { createRazorpayOrder } =
      await import("../../lib/payments/core/razorpay");

    await expect(
      createRazorpayOrder({
        amount: 100000,
        currency: "USD",
        metadata: { appointmentType: "CONSULTATION" },
        paymentGateway: "RAZORPAY",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "NON_INR_SETTLEMENT" }));

    expect(ordersCreate).not.toHaveBeenCalled();
  });
});
