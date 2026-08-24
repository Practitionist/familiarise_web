/**
 * Form 26Q / Form 140 draft builder — quarterly TDS return scaffold (#1230).
 *
 * TDS on consultant payouts accrues into `TDSRecord` rows continuously; the
 * filing-side half was missing entirely (no FVU/portal export anywhere, and
 * org-rail withholding has NO return artifact at all — see the warning below).
 * From FY 2026-27 the quarterly resident return moves from Form 26Q to
 * **Form 140** under the Income Tax Act 2025; this builder emits the data
 * shape for both labels and leaves portal serialization (FVU) as the
 * explicit remaining step.
 *
 * Reversal semantics: refund-triggered reversals arrive as negative
 * `tdsDeducted` rows (`isReversal: true`) — they net against the quarter's
 * deduction rather than being dropped, mirroring how the portal treats
 * late-claim adjustments.
 *
 * Pure module (no Prisma import) so it stays unit-testable under jsdom.
 */

export interface TdsReturnSourceRow {
  consultantProfileId: string;
  tdsSection: string | null;
  /** Amount credited/paid to the deductee this record covers, paise. */
  amountCreditedPaise: number;
  /** TDS deducted (negative for reversal records), paise. */
  tdsDeductedPaise: number;
  isReversal: boolean;
}

export interface TdsReturnDraft {
  formLabel: "FORM_26Q" | "FORM_140";
  financialYear: string;
  quarter: number;
  /** Deductee-count for the challan annex. */
  deductees: Array<{
    consultantProfileId: string;
    tdsSection: string;
    amountCreditedPaise: number;
    tdsDeductedNetPaise: number;
  }>;
  totalAmountCreditedPaise: number;
  totalTdsDeductedNetPaise: number;
  warnings: string[];
}

/**
 * IST fiscal quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
 * Accepts any instant inside the quarter.
 */
export function indianFyQuarterOf(instantUTC: Date): {
  financialYear: string;
  quarter: number;
} {
  const ist = new Date(instantUTC.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1; // 1..12
  // Indian FY runs Apr→Mar; FY label uses the START calendar year ("2026-27").
  const fyStartYear = m >= 4 ? y : y - 1;
  const quarter = Math.ceil(((m - 4 + 12) % 12 + 1) / 3);
  return {
    financialYear: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`,
    quarter,
  };
}

export function buildTdsReturnDraft(
  rows: TdsReturnSourceRow[],
  financialYear: string,
  quarter: number,
): TdsReturnDraft {
  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push("No TDSRecord rows in scope — verify the payout pipeline ran this quarter.");
  }

  let totalAmountCreditedPaise = 0;
  let totalTdsDeductedNetPaise = 0;
  const byDeductee = new Map<
    string,
    {
      consultantProfileId: string;
      tdsSection: string;
      amountCreditedPaise: number;
      tdsDeductedNetPaise: number;
    }
  >();

  for (const row of rows) {
    const credited = Math.max(0, Math.round(row.amountCreditedPaise));
    const tds = Math.round(row.tdsDeductedPaise); // negatives are legitimate (reversals)
    totalAmountCreditedPaise += credited;
    totalTdsDeductedNetPaise += tds;

    const key = `${row.consultantProfileId}:${row.tdsSection ?? "UNKNOWN"}`;
    const agg = byDeductee.get(key) ?? {
      consultantProfileId: row.consultantProfileId,
      tdsSection: row.tdsSection ?? "UNKNOWN",
      amountCreditedPaise: 0,
      tdsDeductedNetPaise: 0,
    };
    agg.amountCreditedPaise += credited;
    agg.tdsDeductedNetPaise += tds;
    byDeductee.set(key, agg);
  }

  if ([...byDeductee.values()].some((d) => d.tdsSection === "UNKNOWN")) {
    warnings.push(
      "Some rows carry no tdsSection — they cannot be classified onto a Form 140 payment code until payout stamping covers them.",
    );
  }
  warnings.push(
    "Org-rail (host organisation) withholding lives only on OrganizationPayout rows and produces no return line here — a CA decision is required on how it files.",
  );

  return {
    // The IT Act 2025 renames the resident quarterly return from FY 2026-27.
    formLabel: financialYear >= "2026-27" ? "FORM_140" : "FORM_26Q",
    financialYear,
    quarter,
    deductees: [...byDeductee.values()].sort(
      (a, b) => b.tdsDeductedNetPaise - a.tdsDeductedNetPaise,
    ),
    totalAmountCreditedPaise,
    totalTdsDeductedNetPaise,
    warnings,
  };
}
