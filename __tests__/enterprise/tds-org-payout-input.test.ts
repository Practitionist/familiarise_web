/**
 * @jest-environment node
 */

/**
 * Validates the TDS inputs that `org-payout-service.ts` constructs for
 * `computeTdsForPayout` produce the expected withholding shape. The
 * full `computeTdsForPayout` matrix is covered in tds-derivation.test.ts;
 * this file pins down the org-payout-specific shape:
 *   - host orgs are RESIDENT in v1
 *   - PAN comes from Organization.pan
 *   - Section 194-O default (0.1%) applies
 *   - missing/malformed PAN → Section 194-O 5% no-PAN carve-out
 *
 * Together these guard against the regression where the org pipeline
 * silently ships `tdsAmountPaise=0` because the old code never called
 * the TDS helper at all.
 */

import { computeTdsForPayout } from "@/lib/compliance/tds";

describe("org payout TDS construction", () => {
  it("Resident host org with valid PAN → 194-O 0.1%", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: "AAACA1234B",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRate: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsSection).toBe("194O");
    expect(r.tdsRate).toBeCloseTo(0.001, 6);
    expect(r.tdsAmountPaise).toBe(1_000); // 0.1% of 10L paise
    expect(r.fallbackApplied).toBe(false);
  });

  it("Resident host org with missing PAN → 194-O 5% no-PAN carve-out", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: null,
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRate: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsRate).toBeCloseTo(0.05, 6);
    expect(r.tdsAmountPaise).toBe(50_000);
    expect(r.fallbackApplied).toBe(true);
  });

  it("Resident host org with malformed PAN → 194-O 5% no-PAN carve-out", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: "invalid",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRate: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.fallbackApplied).toBe(true);
    expect(r.tdsAmountPaise).toBe(50_000);
  });

  it("rounds down (Math.floor) — never over-withholds", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 9_999, // 0.1% = 9.999 paise → 9
      consultant: {
        panNumber: "AAACA1234B",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRate: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsAmountPaise).toBe(9);
  });
});
