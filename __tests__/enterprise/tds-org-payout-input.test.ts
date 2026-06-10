/**
 * @jest-environment node
 */

/**
 * Validates the TDS inputs that `org-payout-service.ts` constructs for
 * `computeTdsForPayout` produce the expected withholding shape. The
 * full `computeTdsForPayout` matrix is covered in tds-derivation.test.ts;
 * this file pins down the org-payout-specific shape:
 *   - host orgs are RESIDENT in v1
 *   - PAN is encrypted at rest → signalled via `panOnFile` (#785), NOT by
 *     passing the ciphertext as `panNumber`
 *   - Section 194-O default (0.1%) applies when a PAN is on file
 *   - missing PAN → Section 194-O 5% no-PAN carve-out
 *
 * Together these guard against the regression where the org pipeline
 * silently ships `tdsAmountPaise=0` because the old code never called
 * the TDS helper at all — and the #785 regression where the encrypted-PAN
 * ciphertext was passed as `panNumber` and wrongly hit the 5% fallback.
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
        tdsRateBps: null,
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
        tdsRateBps: null,
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
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.fallbackApplied).toBe(true);
    expect(r.tdsAmountPaise).toBe(50_000);
  });

  it("#785 — encrypted PAN on file (the REAL org-payout input) → 0.1%, not 5%", () => {
    // org-payout-service passes panNumber:null + panOnFile:!!panEncrypted.
    const r = computeTdsForPayout({
      grossAmountPaise: 4_000_000,
      consultant: {
        panNumber: null,
        panOnFile: true,
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsSection).toBe("194O");
    expect(r.tdsRate).toBeCloseTo(0.001, 6);
    expect(r.tdsAmountPaise).toBe(4_000); // 0.1% — NOT 200_000 (the 5% bug)
    expect(r.fallbackApplied).toBe(false);
  });

  it("#785 — passing the ciphertext as panNumber WOULD wrongly fall back (documents the bug)", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 4_000_000,
      consultant: {
        panNumber: "ENCRYPTED", // the old, wrong shape — ciphertext as PAN
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    // This is why callers MUST use panOnFile: the ciphertext fails isValidPan.
    expect(r.fallbackApplied).toBe(true);
    expect(r.tdsAmountPaise).toBe(200_000); // 5% — the over-withholding
  });

  it("rounds down (Math.floor) — never over-withholds", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 9_999, // 0.1% = 9.999 paise → 9
      consultant: {
        panNumber: "AAACA1234B",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsAmountPaise).toBe(9);
  });
});
