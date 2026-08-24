/**
 * @jest-environment node
 */

/**
 * #1230 — TDS return draft builder invariants: FY/quarter labelling on IST
 * edges, reversal netting, per-deductee section classification, and the
 * Form 26Q→140 label switch at FY 2026-27.
 */

import {
  buildTdsReturnDraft,
  indianFyQuarterOf,
  type TdsReturnSourceRow,
} from "@/lib/compliance/tds-return";

describe("indianFyQuarterOf", () => {
  it("maps calendar months to IST fiscal quarters with the Apr-start FY label", () => {
    expect(indianFyQuarterOf(new Date("2026-04-15T00:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 1,
    });
    // Mid-September IST (not 20:00Z, which is already Oct 1 IST).
    expect(indianFyQuarterOf(new Date("2026-09-30T10:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 2,
    });
    expect(indianFyQuarterOf(new Date("2026-12-31T10:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 3,
    });
    expect(indianFyQuarterOf(new Date("2027-01-01T00:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 4,
    });
  });

  it("a March instant belongs to the PREVIOUS FY label (IST-aware)", () => {
    // 19:00Z = Apr 1 00:30 IST → NEW fiscal year already.
    expect(indianFyQuarterOf(new Date("2026-03-31T19:00:00Z")).financialYear).toBe(
      "2026-27",
    );
    // 18:29:59Z is still Mar 31 23:59 IST → prior-FY Q4; 18:30Z tips over.
    expect(indianFyQuarterOf(new Date("2026-03-31T18:29:59Z")).quarter).toBe(4);
    expect(indianFyQuarterOf(new Date("2026-03-31T18:30:01Z")).quarter).toBe(1);
    // 17:00Z = 22:30 IST on Mar 31 → previous FY.
    expect(indianFyQuarterOf(new Date("2026-03-31T17:00:00Z")).financialYear).toBe(
      "2025-26",
    );
  });
});

describe("buildTdsReturnDraft", () => {
  const base: TdsReturnSourceRow[] = [
    {
      consultantProfileId: "c1",
      tdsSection: "194O",
      amountCreditedPaise: 1_000_000,
      tdsDeductedPaise: 1_000,
      isReversal: false,
    },
    {
      consultantProfileId: "c1",
      tdsSection: "194O",
      amountCreditedPaise: 500_000,
      tdsDeductedPaise: -500,
      isReversal: true,
    },
    {
      consultantProfileId: "c2",
      tdsSection: null,
      amountCreditedPaise: 250_000,
      tdsDeductedPaise: 2_500,
      isReversal: false,
    },
  ];

  it("nets reversals into the deduction totals and classifies by section", () => {
    const d = buildTdsReturnDraft(base, "2026-27", 1);
    expect(d.totalAmountCreditedPaise).toBe(1_750_000);
    // 1000 - 500 + 2500
    expect(d.totalTdsDeductedNetPaise).toBe(3_000);
    const c1 = d.deductees.find((x) => x.consultantProfileId === "c1");
    expect(c1?.tdsDeductedNetPaise).toBe(500);
    // Unstamped rows land under UNKNOWN with a warning, never silently dropped.
    expect(d.deductees.find((x) => x.tdsSection === "UNKNOWN")).toBeDefined();
    expect(d.warnings.join(" ")).toMatch(/tdsSection/);
  });

  it("switches the form label at FY 2026-27 (IT Act 2025 renumbering)", () => {
    expect(buildTdsReturnDraft(base, "2025-26", 4).formLabel).toBe("FORM_26Q");
    expect(buildTdsReturnDraft(base, "2026-27", 1).formLabel).toBe("FORM_140");
  });

  it("flags an empty quarter instead of filing silent zeros", () => {
    const d = buildTdsReturnDraft([], "2026-27", 3);
    expect(d.warnings.join(" ")).toMatch(/payout pipeline/i);
  });

  it("always warns about the org-rail return-artifact gap", () => {
    const d = buildTdsReturnDraft([], "2026-27", 3);
    expect(d.warnings.join(" ")).toMatch(/OrganizationPayout/);
  });
});
