/**
 * Regression tests for the enterprise-audit fixes in #1132.
 *
 * Each block below encodes a defect that shipped and survived review, so the
 * test is written against the behaviour that was wrong rather than against the
 * implementation that now happens to be right.
 */

import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { numericStateCode } from "@/lib/compliance/state-codes";
import { ageInYears, isAdult, AGE_OF_MAJORITY } from "@/lib/compliance/age";
import {
  resolve194OTaxablePaise,
  TDS_194O_EXEMPTION_PAISE,
} from "@/lib/compliance/tds-194o";

describe("GST place of supply (#1132)", () => {
  // The bug: the seller side is env-sourced alpha ("KA") and the buyer side is
  // written numeric ("29"), so `buyerStateCode === supplierStateCode` was never
  // true and the intra-state branch was unreachable dead code.
  it("treats alpha KA and numeric 29 as the same state", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_000,
      supplierStateCode: "KA",
      buyerStateCode: "29",
      buyerCountry: "IN",
    });
    expect(r.reason).toBe("INTRA_STATE_CGST_SGST");
    expect(r.igstPaise).toBe(0);
    expect(r.cgstPaise + r.sgstPaise).toBe(18_000);
  });

  it("still charges IGST across genuinely different states", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_000,
      supplierStateCode: "KA", // 29
      buyerStateCode: "27", // MH
      buyerCountry: "IN",
    });
    expect(r.reason).toBe("INTER_STATE_IGST");
    expect(r.igstPaise).toBe(18_000);
    expect(r.cgstPaise + r.sgstPaise).toBe(0);
  });

  it("prefers the GSTIN prefix over a stored state code", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_000,
      supplierStateCode: "KA",
      buyerStateCode: "27", // stale/incorrect
      buyerGstin: "29AAFCF1234Q1ZN", // authoritative: Karnataka
      buyerCountry: "IN",
    });
    expect(r.reason).toBe("INTRA_STATE_CGST_SGST");
  });

  it("falls back to IGST and flags it when the buyer state cannot be resolved", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_000,
      supplierStateCode: "KA",
      buyerStateCode: "NOT_A_STATE",
      buyerCountry: "IN",
    });
    // An unmappable code must read as unknown, never as a real inter-state
    // supply and never as a match.
    expect(r.reason).toBe("IGST_STATE_UNKNOWN");
    expect(r.igstPaise).toBe(18_000);
  });

  it("keeps CGST and SGST summing exactly to the tax on odd amounts", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_001,
      supplierStateCode: "29",
      buyerStateCode: "29",
      buyerCountry: "IN",
    });
    expect(r.cgstPaise + r.sgstPaise).toBe(r.totalPaise - r.subtotalPaise);
  });

  it("leaves exports zero-rated", () => {
    const r = deriveGstBreakdown({
      subtotalPaise: 100_000,
      supplierStateCode: "KA",
      buyerStateCode: null,
      buyerCountry: "US",
    });
    expect(r.reason).toBe("ZERO_RATED_EXPORT");
    expect(r.totalPaise).toBe(100_000);
  });
});

describe("numericStateCode", () => {
  it("maps alpha, passes through numeric, and rejects junk", () => {
    expect(numericStateCode(null, "KA")).toBe("29");
    expect(numericStateCode(null, "29")).toBe("29");
    expect(numericStateCode(null, " ka ")).toBe("29");
    expect(numericStateCode(null, "ZZ")).toBeNull();
    expect(numericStateCode(null, null)).toBeNull();
  });
});

describe("DPDP age gate (#1132)", () => {
  const asOf = new Date("2026-08-11T00:00:00Z");

  it("uses 18, not the COPPA 13, as the age of majority", () => {
    expect(AGE_OF_MAJORITY).toBe(18);
    // A 15-year-old was previously accepted with no check at all.
    expect(isAdult(new Date("2011-01-01T00:00:00Z"), asOf)).toBe(false);
  });

  it("counts an 18th birthday on the day itself", () => {
    expect(isAdult(new Date("2008-08-11T00:00:00Z"), asOf)).toBe(true);
    expect(isAdult(new Date("2008-08-12T00:00:00Z"), asOf)).toBe(false);
  });

  it("fails closed on missing, future and absurd dates", () => {
    expect(isAdult(null, asOf)).toBe(false);
    expect(isAdult(undefined, asOf)).toBe(false);
    expect(isAdult("not a date", asOf)).toBe(false);
    expect(isAdult(new Date("2030-01-01T00:00:00Z"), asOf)).toBe(false);
    expect(isAdult(new Date("1850-01-01T00:00:00Z"), asOf)).toBe(false);
  });

  it("computes whole years correctly across a birthday boundary", () => {
    expect(ageInYears(new Date("2000-12-31T00:00:00Z"), asOf)).toBe(25);
    expect(ageInYears(new Date("2000-01-01T00:00:00Z"), asOf)).toBe(26);
  });
});

describe("Section 194-O taxable base (#1132)", () => {
  const FIVE_LAKH = TDS_194O_EXEMPTION_PAISE;

  it("uses 5,00,000 as the exemption, not the 50,000 194J figure", () => {
    expect(FIVE_LAKH).toBe(50_000_000);
  });

  it("exempts an individual with PAN below the limit", () => {
    const r = resolve194OTaxablePaise({
      grossBeforePaise: 0,
      grossThisPayoutPaise: 10_000_000, // ₹1L
      entityType: "INDIVIDUAL",
      panOnFile: true,
    });
    expect(r.taxablePaise).toBe(0);
  });

  it("taxes only the excess on the payout that crosses the exemption", () => {
    const r = resolve194OTaxablePaise({
      grossBeforePaise: FIVE_LAKH - 1_000_000,
      grossThisPayoutPaise: 3_000_000,
      entityType: "HUF",
      panOnFile: true,
    });
    expect(r.taxablePaise).toBe(2_000_000);
  });

  it("taxes the whole payout once the exemption is exhausted", () => {
    const r = resolve194OTaxablePaise({
      grossBeforePaise: FIVE_LAKH + 1,
      grossThisPayoutPaise: 2_500_000,
      entityType: "INDIVIDUAL",
      panOnFile: true,
    });
    expect(r.taxablePaise).toBe(2_500_000);
  });

  // The three limbs are conjunctive. Companies, firms and LLPs have NO
  // threshold under 194-O — withholding starts at the first rupee.
  it.each(["COMPANY", "LLP", "PARTNERSHIP"])(
    "gives %s no threshold even with PAN and a tiny amount",
    (entityType) => {
      const r = resolve194OTaxablePaise({
        grossBeforePaise: 0,
        grossThisPayoutPaise: 100_000,
        entityType,
        panOnFile: true,
      });
      expect(r.taxablePaise).toBe(100_000);
    },
  );

  it("withdraws the exemption when PAN is absent", () => {
    const r = resolve194OTaxablePaise({
      grossBeforePaise: 0,
      grossThisPayoutPaise: 100_000,
      entityType: "INDIVIDUAL",
      panOnFile: false,
    });
    expect(r.taxablePaise).toBe(100_000);
  });

  it("treats an unknown entity type as ineligible rather than exempt", () => {
    // Under-withholding is our s.201 liability; over-withholding the
    // consultant reclaims at assessment. Fail toward withholding.
    const r = resolve194OTaxablePaise({
      grossBeforePaise: 0,
      grossThisPayoutPaise: 100_000,
      entityType: null,
      panOnFile: true,
    });
    expect(r.taxablePaise).toBe(100_000);
  });
});
