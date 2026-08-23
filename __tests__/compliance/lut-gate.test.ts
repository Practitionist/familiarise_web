/**
 * @jest-environment node
 */

/**
 * #1230 — the platform-LUT gate on export zero-rating.
 *
 * Rule 96A / Form RFD-11: zero-rating an export without paying IGST requires
 * a LUT valid for the CURRENT financial year. Before this gate the platform
 * zero-rated on buyer country alone, accruing a retrospective 18% + interest
 * exposure on every foreign invoice. Both pricing surfaces (checkout
 * determineTax and invoicing deriveGstBreakdown) must fail closed together,
 * and flip to zero-rated together, from the same env signal.
 */

import { readPlatformLut, hasValidPlatformLut } from "@/lib/compliance/lut";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { determineTax } from "@/lib/payments/tax/tax-engine";

function setLut(number: string | null, validTill: string | null) {
  if (number) process.env.PLATFORM_LUT_NUMBER = number;
  else delete process.env.PLATFORM_LUT_NUMBER;
  if (validTill) process.env.PLATFORM_LUT_VALID_TILL = validTill;
  else delete process.env.PLATFORM_LUT_VALID_TILL;
}

afterEach(() => {
  setLut(null, null);
});

describe("readPlatformLut / hasValidPlatformLut", () => {
  it("absent env ⇒ not present, not valid (fail-closed)", () => {
    const s = readPlatformLut(new Date("2026-08-23T00:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
    expect(hasValidPlatformLut(new Date("2026-08-23T00:00:00Z"))).toBe(false);
  });

  it("number without validity date ⇒ present but never valid", () => {
    setLut("AD270326000001L/2627", null);
    const s = readPlatformLut(new Date("2026-08-23T00:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
  });

  it("validity date is inclusive through end-of-day", () => {
    setLut("LUT/2627", "2027-03-31");
    // Last instant of the FY is covered...
    expect(
      hasValidPlatformLut(new Date("2027-03-31T12:00:00Z")),
    ).toBe(true);
    // ...the first instant after it is not.
    expect(
      hasValidPlatformLut(new Date("2027-04-01T00:00:00Z")),
    ).toBe(false);
  });
});

describe("deriveGstBreakdown export branch", () => {
  const base = {
    subtotalPaise: 100_000,
    supplierStateCode: "29",
    buyerStateCode: null as string | null,
    buyerGstin: null as string | null,
    buyerCountry: "US",
    hsnCode: "9982",
  };

  it("no LUT ⇒ full 18% IGST with EXPORT_NO_LUT_IGST reason", () => {
    setLut(null, null);
    const r = deriveGstBreakdown(base);
    expect(r.reason).toBe("EXPORT_NO_LUT_IGST");
    expect(r.igstPaise).toBe(18_000);
    expect(r.cgstPaise).toBe(0);
    expect(r.totalPaise).toBe(118_000);
  });

  it("valid LUT ⇒ zero-rated exactly as before", () => {
    setLut("LUT/2627", "2027-03-31");
    const r = deriveGstBreakdown(base);
    expect(r.reason).toBe("ZERO_RATED_EXPORT");
    expect(r.igstPaise).toBe(0);
    expect(r.totalPaise).toBe(base.subtotalPaise);
  });

  it("expired LUT ⇒ taxable (renewal trap)", () => {
    setLut("LUT/2526", "2026-03-31");
    const r = deriveGstBreakdown({ ...base, buyerCountry: "DE" });
    expect(r.reason).toBe("EXPORT_NO_LUT_IGST");
    expect(r.igstPaise).toBe(18_000);
  });
});

describe("determineTax export branch (checkout parity)", () => {
  it("no LUT ⇒ 18% IN-GST treatment with explanatory notes", () => {
    setLut(null, null);
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "US" });
    expect(r.isZeroRated).toBe(false);
    expect(r.taxRate).toBe(18);
    expect(r.taxAmount).toBe(18_000);
    expect(r.jurisdiction).toBe("IN-GST");
    expect(r.notes).toMatch(/Rule 96A/i);
  });

  it("valid LUT ⇒ zero-rated export", () => {
    setLut("LUT/2627", "2027-03-31");
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "GB" });
    expect(r.isZeroRated).toBe(true);
    expect(r.taxAmount).toBe(0);
    expect(r.jurisdiction).toBe("EXPORT-ZERO");
  });

  it("domestic supply is unaffected by LUT state", () => {
    setLut(null, null);
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "IN" });
    expect(r.jurisdiction).toBe("IN-GST");
    expect(r.taxAmount).toBe(18_000);
  });
});
