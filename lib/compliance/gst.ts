/**
 * GST (Goods and Services Tax) derivation — INDIA COMPLIANCE.
 *
 * STATUS: LIVE (#771 P2 — header corrected; this was never a stub).
 * `deriveGstBreakdown` computes CGST/SGST vs IGST and zero-rated export. It
 * needs `buyerStateCode` (from Organization.gstStateCode) to pick intra- vs
 * inter-state; it falls back to IGST when the state is unknown — #771 §8 wants
 * that state made mandatory for B2B invoices. HSN default 999293 (educational);
 * set 998314 / 998399 for professional / IT-consulting lines.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Place-of-supply resolution (Sec 12 & 13 IGST Act):
 *      - B2B (both parties registered): place-of-supply = buyer's GSTIN state.
 *      - B2C: place-of-supply = buyer's registered address state.
 *      - Cross-border export of services (supplier IN → buyer foreign):
 *          * Zero-rated under IGST Act s.16 if payment in convertible forex.
 *          * Requires LUT (Letter of Undertaking) filed with GST authorities
 *            — captured in `OrganizationInvoice.lutNumber`.
 *      - Imports of services (foreign supplier → buyer IN): reverse charge
 *          mechanism (RCM) — `reverseCharge = true`, buyer pays GST.
 *
 * 2. IGST vs CGST+SGST split:
 *      - If place-of-supply state == supplier state → CGST (9%) + SGST (9%)
 *        = 18% total. Split 50/50.
 *      - If place-of-supply state != supplier state → IGST 18% only.
 *      - For services, default HSN/SAC code is 999293 (educational services).
 *      - Reclassify for consultancy: 998399 (other professional services).
 *
 * 3. GSTIN format: 15 characters. First 2 = state code. Characters 3-12 =
 *    PAN. Character 13 = entity number. Character 14 = 'Z' literal.
 *    Character 15 = checksum.
 *    Regex: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.
 *
 * 4. Regular vs composition scheme (`gstRegStatus`):
 *      - REGULAR: normal 18% with ITC.
 *      - COMPOSITION: 6% flat, no ITC (unlikely for B2B SaaS; flagged only).
 *      - UNREGISTERED: no GST, but buyer may apply RCM.
 *
 * 5. Invoice numbering: sequential per financial year per billing account,
 *    must be continuous. Use a DB sequence or row-lock helper — never
 *    regenerate after issue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface GstBreakdown {
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  hsnCode: string;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  reason: string;
}

const GST_RATE = 0.18; // 18% standard rate for SAC 999293 / 998399

/**
 * Derives GST breakdown for an invoice line subtotal.
 *
 * Rules (Sec 12 & 13 IGST Act):
 *  - Export (buyerCountry !== "IN"): zero-rated under IGST Act s.16
 *  - Intra-state (buyerState === supplierState): CGST 9% + SGST 9%
 *  - Inter-state (buyerState !== supplierState): IGST 18%
 *  - Unknown buyer state → falls back to IGST (conservative)
 */
export function deriveGstBreakdown(params: {
  subtotalPaise: number;
  supplierStateCode: string | null;
  buyerStateCode: string | null;
  buyerCountry: string;
  hsnCode?: string;
}): GstBreakdown {
  const hsnCode = params.hsnCode ?? "999293";
  const placeOfSupply = params.buyerStateCode ?? params.supplierStateCode ?? null;

  // Zero-rated export
  if (params.buyerCountry !== "IN") {
    return {
      subtotalPaise: params.subtotalPaise,
      igstPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      totalPaise: params.subtotalPaise,
      hsnCode,
      placeOfSupply,
      reverseCharge: false,
      reason: "ZERO_RATED_EXPORT",
    };
  }

  const taxPaise = Math.round(params.subtotalPaise * GST_RATE);

  // Intra-state: CGST + SGST split 50/50
  if (
    params.buyerStateCode &&
    params.supplierStateCode &&
    params.buyerStateCode === params.supplierStateCode
  ) {
    // #776 — deterministic split: floor CGST, SGST absorbs the odd-paise
    // remainder so cgst+sgst === taxPaise exactly. The prior `Math.round(taxPaise/2)`
    // on both legs over-stated the total by 1 paise for odd taxPaise (~50% of
    // non-round subtotals), inflating OrganizationInvoice.totalPaise and
    // desyncing the accrual vs INVOICE_PAID ledger postings.
    const cgstPaise = Math.floor(taxPaise / 2);
    const sgstPaise = taxPaise - cgstPaise;
    return {
      subtotalPaise: params.subtotalPaise,
      igstPaise: 0,
      cgstPaise,
      sgstPaise,
      totalPaise: params.subtotalPaise + taxPaise,
      hsnCode,
      placeOfSupply,
      reverseCharge: false,
      reason: "INTRA_STATE_CGST_SGST",
    };
  }

  // Inter-state, or unknown buyer state. #771 §8 — flag the unknown-state case
  // distinctly so a missing place-of-supply that silently defaulted to IGST is
  // visible in the stored reason (auditable), rather than masquerading as a real
  // inter-state supply.
  const igstReason = !params.buyerStateCode
    ? "IGST_STATE_UNKNOWN"
    : "INTER_STATE_IGST";
  return {
    subtotalPaise: params.subtotalPaise,
    igstPaise: taxPaise,
    cgstPaise: 0,
    sgstPaise: 0,
    totalPaise: params.subtotalPaise + taxPaise,
    hsnCode,
    placeOfSupply,
    reverseCharge: false,
    reason: igstReason,
  };
}

/**
 * STUB: Validates a GSTIN format. Real impl includes checksum verification.
 */
export function isValidGstin(g: string | null | undefined): boolean {
  if (!g) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
}

/**
 * STUB: Resolves place-of-supply for a transaction. Returns null for
 * export/import scenarios.
 */
export function resolvePlaceOfSupply(params: {
  supplierStateCode: string | null;
  buyerStateCode: string | null;
  buyerCountry: string;
}): string | null {
  if (params.buyerCountry !== "IN") return null; // export
  return params.buyerStateCode ?? params.supplierStateCode ?? null;
}
