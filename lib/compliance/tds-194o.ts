/**
 * Section 194-O taxable-base resolution — pure tax math, no I/O (#1132).
 *
 * Deliberately separate from lib/payments/tax/tds-service.ts, which imports
 * Prisma: the statutory rules below are worth testing in isolation, and pulling
 * a database client into that test buys nothing.
 *
 * Income-tax Act 2025 mapping: s.194-O is s.393(1) Table Sl. 8(v), payment code 1035.
 * The base is the GROSS amount of the sale or service — CBDT Circulars 17/2020
 * and 20/2021 are explicit that the operator's retained commission is not
 * deductible from it, and Note 3 to s.393 even deems direct
 * customer-to-participant payments into the gross.
 * CBDT Circular 20/2023 keeps fees and commission in that gross base; separately stated
 * GST is excluded only when TDS is deducted at credit (at payment it stays in).
 */

/**
 * Section 194-O exemption per financial year in paise (₹5,00,000 = 50,000,000).
 * #1132 — distinct from TDS_THRESHOLD_PAISE above, which is the 194J figure and
 * was being applied to 194-O by mistake (10x too low).
 *
 * The exemption is only available when ALL THREE limbs hold; it is not a
 * general allowance:
 *   1. the participant is an individual or a HUF (companies, firms and LLPs are
 *      withheld from the first rupee — there is no threshold for them), AND
 *   2. gross FY receipts do not exceed ₹5,00,000, AND
 *   3. PAN or Aadhaar has been furnished.
 */
export const TDS_194O_EXEMPTION_PAISE = 50_000_000;

/**
 * Entity types eligible for the 194-O ₹5L exemption (limb 1). Everything else
 * in TaxEntityType — PARTNERSHIP, LLP, COMPANY — is withheld from the first
 * rupee. A null/unknown entity type is treated as ineligible: withholding too
 * much is recoverable by the consultant at assessment, withholding too little
 * is our s.201 liability.
 */
export const TDS_194O_EXEMPT_ENTITY_TYPES = ["INDIVIDUAL", "HUF"] as const;

/**
 * Resolves the 194-O taxable base for a payout, applying the three-limb ₹5L
 * exemption. `grossBeforePaise` / `grossThisPayoutPaise` are GROSS consideration
 * (not net of platform commission), after refunds, for the current financial year.
 *
 * `yearToDate` bases cover the whole FY through this payout: the caller taxes
 * them and subtracts the TDS already assigned to the FY's other payouts.
 */
export function resolve194OTaxablePaise(params: {
  grossBeforePaise: number;
  grossThisPayoutPaise: number;
  entityType: string | null;
  panOnFile: boolean;
}): { taxablePaise: number; yearToDate: boolean; reason: string } {
  const eligible =
    params.panOnFile &&
    params.entityType !== null &&
    (TDS_194O_EXEMPT_ENTITY_TYPES as readonly string[]).includes(
      params.entityType,
    );

  if (!eligible) {
    const why = !params.panOnFile
      ? "no PAN on file"
      : `entity type ${params.entityType ?? "unknown"} has no 194-O threshold`;
    return {
      taxablePaise: params.grossThisPayoutPaise,
      yearToDate: false,
      reason: `194-O exemption not available (${why}) — taxable from the first rupee`,
    };
  }

  const cumulative = params.grossBeforePaise + params.grossThisPayoutPaise;
  if (cumulative <= TDS_194O_EXEMPTION_PAISE) {
    return {
      taxablePaise: 0,
      yearToDate: true,
      reason: `below ₹5L 194-O exemption (cumulative gross=${cumulative} paise)`,
    };
  }
  return {
    taxablePaise: crossingTaxablePaise(cumulative),
    yearToDate: true,
    reason: `above the ₹5L 194-O exemption (cumulative gross=${cumulative} paise)`,
  };
}

/**
 * FY taxable base once the gross passes ₹5L: the whole year-to-date gross,
 * pending CA confirmation. The excess-only reading would be
 * `cumulativePaise - TDS_194O_EXEMPTION_PAISE`.
 */
function crossingTaxablePaise(cumulativePaise: number): number {
  return cumulativePaise;
}

/**
 * Splits a payout's TDS into what it withholds now (never more than
 * `capacityPaise`, so the net never goes negative), what it carries to later
 * payouts, and what it credits back in cash. A negative `dueTdsPaise` means the
 * FY's other payouts already withheld more than the year now owes.
 * `carryPaise` is signed: positive carries TDS forward, negative collects carry-in.
 */
export function settle194OWithholding(params: {
  dueTdsPaise: number;
  carryInPaise: number;
  capacityPaise: number;
}): { withholdPaise: number; creditPaise: number; carryPaise: number } {
  const total = params.dueTdsPaise + params.carryInPaise;
  const withholdPaise = Math.min(
    Math.max(total, 0),
    Math.max(params.capacityPaise, 0),
  );
  return {
    withholdPaise,
    creditPaise: Math.max(-total, 0),
    carryPaise: Math.max(total, 0) - withholdPaise - params.carryInPaise,
  };
}
