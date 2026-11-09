/**
 * @jest-environment node
 */

/**
 * The gates that decide real money on a consumer supply, every one of which
 * was open.
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

import fs from "node:fs";
import path from "node:path";

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
import { assertGatewayUsable } from "../../lib/payments/validation/gateway-guards";
import {
  deriveConsumerInvoiceTax,
  deriveConsumerCreditNoteAmounts,
  mintConsumerInvoice,
  type ConsumerCreditNoteAmounts,
} from "../../lib/payments/billing/consumer-invoice";
import {
  getPlatformSupplier,
  resolveSupplierStateCode,
} from "../../lib/pdf/supplier";
import { REGISTERED_OFFICE } from "../../lib/company";

// The mint's fail-closed branch is the only I/O-bearing path pinned here; the
// supplier config, the system-event write and Sentry are all stubbed so the
// assertion is about the decision, not the plumbing.
jest.mock("../../lib/pdf/supplier", () => ({
  ...jest.requireActual("../../lib/pdf/supplier"),
  getPlatformSupplier: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
import { reportSentryMessage } from "../../lib/observability/report";

const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

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
    const src = readRepoFile("lib/payments/operations/approval-payment.ts");
    const calls = src.match(/validatePlanCurrency\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the planner cannot create an unsettleable plan", () => {
  it("offers INR only", () => {
    const src = readRepoFile(
      "components/planner/components/form-fields/PriceField.tsx",
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

describe("a gateway with no implementation is refused", () => {
  it("rejects STRIPE and leaves RAZORPAY open", () => {
    expect(() => assertGatewayUsable("STRIPE", "route a checkout")).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_GATEWAY" }),
    );
    expect(() =>
      assertGatewayUsable("RAZORPAY", "route a checkout"),
    ).not.toThrow();
  });
});

/**
 * 3. Place of supply for a consumer invoice (#1365). Sec 12(2)(b) IGST Act
 *    puts a B2C supply at the SUPPLIER's location when the recipient's
 *    address is not on record — the opposite of the B2B fallback, which
 *    reports IGST on an unknown buyer state as an audit signal. Getting that
 *    backwards files the tax under the wrong heads in the wrong state.
 */
describe("B2C place of supply (s.12(2)(b))", () => {
  // ₹1,000 + 18% GST, tax-inclusive.
  const CHARGED = { totalPaise: 118_000, taxAmountPaise: 18_000 };

  it("splits CGST and SGST when the buyer is in the supplier's state", () => {
    const tax = deriveConsumerInvoiceTax({
      ...CHARGED,
      buyerStateCode: "29",
      supplierStateCode: "KA",
      buyerCountry: "IN",
    });
    expect(tax.igstPaise).toBe(0);
    expect(tax.cgstPaise + tax.sgstPaise).toBe(CHARGED.taxAmountPaise);
    expect(tax.placeOfSupply).toBe("29");
    expect(tax.placeOfSupplySource).toBe("DECLARED_AT_CHECKOUT");
    expect(
      tax.taxableValuePaise + tax.cgstPaise + tax.sgstPaise + tax.igstPaise,
    ).toBe(tax.totalPaise);
  });

  it("charges IGST only when the buyer is in another state", () => {
    const tax = deriveConsumerInvoiceTax({
      ...CHARGED,
      buyerStateCode: "27",
      supplierStateCode: "KA",
      buyerCountry: "IN",
    });
    expect(tax.igstPaise).toBe(CHARGED.taxAmountPaise);
    expect(tax.cgstPaise).toBe(0);
    expect(tax.sgstPaise).toBe(0);
    expect(tax.placeOfSupply).toBe("27");
    expect(tax.placeOfSupplySource).toBe("DECLARED_AT_CHECKOUT");
    expect(tax.taxableValuePaise + tax.igstPaise).toBe(tax.totalPaise);
  });

  it("falls back to the supplier's own state for an older payment with no buyer state", () => {
    const tax = deriveConsumerInvoiceTax({
      ...CHARGED,
      buyerStateCode: null,
      supplierStateCode: "KA",
      buyerCountry: "IN",
    });
    expect(tax.placeOfSupplySource).toBe("SUPPLIER_DEFAULT_12_2_B");
    expect(tax.igstPaise).toBe(0);
    expect(tax.placeOfSupply).toBe("29");
    expect(tax.cgstPaise + tax.sgstPaise).toBe(CHARGED.taxAmountPaise);
    expect(
      tax.taxableValuePaise + tax.cgstPaise + tax.sgstPaise + tax.igstPaise,
    ).toBe(tax.totalPaise);
  });

  it("gives the odd paise of an uneven tax to SGST", () => {
    // Every other fixture here charges an even tax, so the floor-CGST rule is
    // indistinguishable from a plain halving. This pins the residual: the two
    // heads must still sum to the tax the buyer was actually charged, because
    // that figure is what settlement credited to GST_PAYABLE.
    const tax = deriveConsumerInvoiceTax({
      totalPaise: 118_001,
      taxAmountPaise: 18_001,
      buyerStateCode: "29",
      supplierStateCode: "KA",
      buyerCountry: "IN",
    });
    expect(tax.cgstPaise).toBe(9_000);
    expect(tax.sgstPaise).toBe(9_001);
    expect(tax.cgstPaise + tax.sgstPaise).toBe(18_001);
  });
});

/**
 * 4. The platform's own state. The first two digits of a GSTIN are the state
 *    of registration by law, so the GSTIN is authoritative and the registered
 *    office in lib/company.ts is only the fallback; a disagreement refuses.
 */
describe("the supplier's own state", () => {
  const HARYANA_GSTIN = "06AABCU9603R1ZM";
  const KARNATAKA_GSTIN = "29AABCU9603R1ZM";

  it("comes from the GSTIN and keeps a same-state supply intra-state", () => {
    const { stateCode, mismatch } = resolveSupplierStateCode(
      HARYANA_GSTIN,
      REGISTERED_OFFICE.stateCode,
    );
    expect(mismatch).toBeNull();
    expect(stateCode).toBe("06");

    const tax = deriveConsumerInvoiceTax({
      totalPaise: 118_000,
      taxAmountPaise: 18_000,
      buyerStateCode: "06",
      supplierStateCode: stateCode,
      buyerCountry: "IN",
    });
    expect(tax.igstPaise).toBe(0);
    expect(tax.cgstPaise + tax.sgstPaise).toBe(18_000);
    expect(tax.placeOfSupply).toBe("06");
  });

  it("falls back to the registered office while no GSTIN is set", () => {
    expect(
      resolveSupplierStateCode(null, REGISTERED_OFFICE.stateCode).stateCode,
    ).toBe("06");
  });

  it("refuses to choose when the GSTIN contradicts the registered office", () => {
    const resolved = resolveSupplierStateCode(
      KARNATAKA_GSTIN,
      REGISTERED_OFFICE.stateCode,
    );
    expect(resolved.stateCode).toBeNull();
    expect(resolved.mismatch).toEqual({ fromGstin: "29", registered: "06" });
  });
});

describe("a payment with no declared state", () => {
  it("is invoiced on the buyer's profile state, recorded as PROFILE_ON_RECORD", async () => {
    (getPlatformSupplier as jest.Mock).mockReturnValue({
      name: "Practitionist (OPC) Private Limited",
      gstin: "06AABCU9603R1ZM",
      address: "Gurgaon, Haryana",
    });
    const create = jest.fn(async () => ({ id: "inv_1" }));
    const tx = {
      consumerInvoice: { findUnique: jest.fn(async () => null), create },
      platformInvoiceCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
      payment: {
        findUnique: jest.fn(async () => ({
          id: "pay_profile",
          amount: 118_000,
          taxAmount: 18_000,
          currency: "INR",
          paymentStatus: "SUCCEEDED",
          deletedAt: null,
          buyerCountry: "IN",
          gstRegime: "REGISTERED",
          consumerStateCode: null,
          billableToOrgInvoiceId: null,
          createdAt: new Date("2026-08-10T06:00:00Z"),
          userId: "usr_1",
          legs: [{ source: "CARD" }],
          creditUsages: [],
          refunds: [],
          user: {
            id: "usr_1",
            name: "A Buyer",
            email: "buyer@example.com",
            address: null,
            city: null,
            consulteeProfile: { billingStateCode: "27" },
          },
        })),
      },
    } as unknown as Parameters<typeof mintConsumerInvoice>[0];

    await mintConsumerInvoice(tx, { paymentId: "pay_profile" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          placeOfSupplySource: "PROFILE_ON_RECORD",
          buyerStateCode: "27",
          placeOfSupply: "27",
          igstPaise: 18_000,
        }),
      }),
    );
  });
});

describe("a capture whose payment was refunded before the invoice", () => {
  it("mints nothing and takes no number, because the refund could get no credit note", async () => {
    (getPlatformSupplier as jest.Mock).mockReturnValue({
      name: "Familiarise",
      gstin: "29AABCU9603R1ZM",
      address: "Bengaluru, Karnataka",
    });
    const create = jest.fn(async () => ({ id: "inv_1" }));
    const counter = jest.fn(async () => ({ nextSeq: 2 }));
    const paymentFind = jest.fn(async () => ({
      id: "pay_refunded",
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      billableToOrgInvoiceId: null,
      legs: [{ source: "CARD" }],
      creditUsages: [],
      refunds: [{ id: "rf_1" }],
    }));
    const tx = {
      consumerInvoice: { findUnique: jest.fn(async () => null), create },
      platformInvoiceCounter: { upsert: counter },
      payment: { findUnique: paymentFind },
    } as unknown as Parameters<typeof mintConsumerInvoice>[0];

    const result = await mintConsumerInvoice(tx, { paymentId: "pay_refunded" });

    expect(result.consumerInvoiceId).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(counter).not.toHaveBeenCalled();
    expect(paymentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          refunds: expect.objectContaining({
            where: { status: { in: ["PENDING", "SUCCEEDED"] } },
          }),
        }),
      }),
    );
  });
});

/**
 * With PLATFORM_GSTIN unset the mint no-ops and logs once per process; the
 * healer's config-skip run row carries the signal, not Sentry.
 */
describe("the mint gate stays out of Sentry", () => {
  it("two mints with no supplier → no invoice and no Sentry message", async () => {
    (getPlatformSupplier as jest.Mock).mockReturnValue(null);
    const create = jest.fn();
    const paymentRow = {
      id: "pay_unconfigured",
      amount: 118_000,
      taxAmount: 18_000,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      buyerCountry: "IN",
      gstRegime: "REGISTERED",
      consumerStateCode: "29",
      billableToOrgInvoiceId: null,
      createdAt: new Date("2026-08-10T06:00:00Z"),
      userId: "usr_1",
      legs: [],
      creditUsages: [],
      refunds: [],
      user: {
        id: "usr_1",
        name: "A Buyer",
        email: "buyer@example.com",
        address: null,
        city: null,
        consulteeProfile: { billingStateCode: "29" },
      },
    };
    const tx = {
      consumerInvoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        create,
      },
      payment: { findUnique: jest.fn().mockResolvedValue(paymentRow) },
    } as unknown as Parameters<typeof mintConsumerInvoice>[0];

    const first = await mintConsumerInvoice(tx, {
      paymentId: "pay_unconfigured",
    });
    const second = await mintConsumerInvoice(tx, {
      paymentId: "pay_unconfigured",
    });

    expect(first.consumerInvoiceId).toBeNull();
    expect(second.consumerInvoiceId).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });
});

/**
 * 5. Credit notes (#1370). A partial refund and a later lost chargeback are
 *    two idempotency keys against one invoice, so a per-note cap let them
 *    credit past 100% and understate the period's output tax. And flooring
 *    each head independently left the row short of its own total, which the
 *    register then flagged as a reconciliation warning.
 */
describe("consumer credit notes", () => {
  // ₹590.01 charged, ₹90.01 of it tax — an odd-paise invoice, split by the
  // invoice's own floor-CGST rule (CGST 4,500 / SGST 4,501).
  const INVOICE = {
    invoiceTotalPaise: 59_001,
    invoiceCgstPaise: 4_500,
    invoiceSgstPaise: 4_501,
    invoiceIgstPaise: 0,
  };

  const balances = (a: ConsumerCreditNoteAmounts): number =>
    a.taxableValuePaise + a.cgstPaise + a.sgstPaise + a.igstPaise;

  function credit(alreadyCreditedPaise: number, requestedPaise: number) {
    return deriveConsumerCreditNoteAmounts({
      ...INVOICE,
      alreadyCreditedPaise,
      requestedPaise,
    });
  }

  it("balances a one-third reversal and stays under every invoice head", () => {
    const derived = credit(0, 19_667);
    expect(derived.outcome).toBe("CREDIT");
    if (derived.outcome !== "CREDIT") return;
    expect(derived.amounts).toEqual({
      creditedTotalPaise: 19_667,
      taxableValuePaise: 16_667,
      cgstPaise: 1_500,
      sgstPaise: 1_500,
      igstPaise: 0,
    });
    expect(balances(derived.amounts)).toBe(19_667);
    expect(derived.amounts.cgstPaise).toBeLessThanOrEqual(
      INVOICE.invoiceCgstPaise,
    );
    expect(derived.amounts.sgstPaise).toBeLessThanOrEqual(
      INVOICE.invoiceSgstPaise,
    );
  });

  it("gives the odd credited paise of tax to SGST and the residual to the taxable value", () => {
    const derived = credit(0, 19_672);
    if (derived.outcome !== "CREDIT") throw new Error("expected a credit");
    expect(derived.amounts.cgstPaise).toBe(1_500);
    expect(derived.amounts.sgstPaise).toBe(1_501);
    expect(derived.amounts.taxableValuePaise).toBe(16_671);
    expect(balances(derived.amounts)).toBe(19_672);
  });

  it("caps the second note at the remainder and refuses the third", () => {
    const second = credit(30_000, 40_000);
    if (second.outcome !== "CREDIT") throw new Error("expected a credit");
    expect(second.amounts.creditedTotalPaise).toBe(29_001);
    expect(balances(second.amounts)).toBe(29_001);

    expect(credit(59_001, 1_000).outcome).toBe("FULLY_CREDITED");
  });
});
