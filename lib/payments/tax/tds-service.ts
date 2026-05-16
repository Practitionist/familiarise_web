/**
 * Consultant-side TDS service — Section 194J + Form 26Q audit trail.
 *
 * This is the production pipeline for consultant payouts
 * (`lib/payments/payouts/payout-service.ts`). It owns:
 *   - Section 194J flat 10% / 20% calculation with the ₹50K fiscal-year threshold
 *   - Indian FY date arithmetic (Apr–Mar) and quarter mapping
 *   - Cumulative FY payout aggregation for threshold-crossing math
 *   - `TDSRecord` audit-trail writes (drives Form 26Q quarterly filing)
 *   - Admin queries for the TDS dashboard
 *
 * The companion lib `lib/compliance/tds.ts` handles the org-side payout
 * pipeline with the full 2026 statutory surface (Section 194-O ECO default,
 * 194J, 194C, Section 197 lower-rate certs, Section 206AA PAN fallback,
 * DTAA rate lookup). The two pipelines have different defaults and
 * different audit shapes — unifying them requires accountant signoff on
 * which section governs consultant payouts post-194-O (ECO precedence
 * argument vs the existing 194J threshold-based approach) and is tracked
 * as a separate PR. Do not delete this file without that signoff.
 *
 * Rules encoded here (Section 194J):
 * - Threshold: ₹50,000/financial year (April–March)
 * - Rate: 10% with verified PAN, 20% without PAN (Section 206AA)
 * - Applies to professional/technical services
 * - Must be deposited by 7th of next month
 * - Quarterly filing: Form 26Q
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

// ============================================================================
// Constants
// ============================================================================

/** TDS threshold per financial year in paise (₹50,000 = 5,000,000 paise) */
export const TDS_THRESHOLD_PAISE = 5_000_000;

/** TDS rate with verified PAN (10%) */
export const TDS_RATE_WITH_PAN = 10;

/** TDS rate without PAN (20%) — Section 206AA */
export const TDS_RATE_WITHOUT_PAN = 20;

// ============================================================================
// Financial Year Utilities
// ============================================================================

/**
 * Get Indian financial year string for a date.
 * FY runs April 1 to March 31.
 * e.g., March 2027 → "2026-27", April 2027 → "2027-28"
 */
export function getIndianFinancialYear(date: Date = new Date()): string {
  const month = date.getMonth(); // 0-indexed (0=Jan, 3=Apr)
  const year = date.getFullYear();

  // If Jan-Mar, FY started previous year
  const fyStartYear = month < 3 ? year - 1 : year;
  const fyEndYear = fyStartYear + 1;

  return `${fyStartYear}-${String(fyEndYear).slice(2)}`;
}

/**
 * Get the quarter number (1-4) for a date within the Indian FY.
 * Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar
 */
export function getIndianFYQuarter(date: Date = new Date()): number {
  const month = date.getMonth(); // 0-indexed
  if (month >= 3 && month <= 5) return 1; // Apr-Jun
  if (month >= 6 && month <= 8) return 2; // Jul-Sep
  if (month >= 9 && month <= 11) return 3; // Oct-Dec
  return 4; // Jan-Mar
}

/**
 * Get FY start and end dates for a financial year string.
 */
export function getFYDateRange(fy: string): { start: Date; end: Date } {
  const startYear = parseInt(fy.split("-")[0]);
  return {
    start: new Date(startYear, 3, 1), // April 1
    end: new Date(startYear + 1, 2, 31, 23, 59, 59), // March 31
  };
}

// ============================================================================
// TDS Calculation
// ============================================================================

/**
 * Get cumulative payout amounts actually credited/paid for the current FY.
 * Uses completed payouts as the basis instead of raw earnings creation time.
 */
export async function getCurrentFYCumulativePayments(
  consultantProfileId: string,
  financialYear?: string,
): Promise<number> {
  const fy = financialYear || getIndianFinancialYear();
  const { start, end } = getFYDateRange(fy);

  const result = await prisma.payout.aggregate({
    where: {
      consultantProfileId,
      status: "COMPLETED",
      processedAt: { gte: start, lte: end },
    },
    _sum: { amount: true },
  });

  return result._sum.amount || 0;
}

/**
 * Get cumulative TDS already deducted for a consultant in a FY.
 */
export async function getCumulativeTDSDeducted(
  consultantProfileId: string,
  financialYear?: string,
): Promise<number> {
  const fy = financialYear || getIndianFinancialYear();

  const result = await prisma.tDSRecord.aggregate({
    where: {
      consultantProfileId,
      financialYear: fy,
    },
    _sum: { tdsDeducted: true },
  });

  return result._sum.tdsDeducted || 0;
}

export interface TDSCalculationResult {
  /** TDS amount to deduct, in paise */
  tdsAmount: number;
  /** TDS rate applied (10 or 20) */
  tdsRate: number;
  /** Whether cumulative payments crossed the threshold */
  isAboveThreshold: boolean;
  /** Cumulative credited/payout amounts for FY (BEFORE this payout), in paise */
  cumulativeBeforePayout: number;
  /** Cumulative credited/payout amounts for FY (AFTER this payout), in paise */
  cumulativeAfterPayout: number;
  /** Current financial year */
  financialYear: string;
}

/**
 * Calculate TDS for a payout.
 *
 * TDS applies when cumulative FY payments exceed ₹50,000.
 * If the threshold is crossed mid-payout, TDS is calculated on:
 * - The excess amount if this payout crosses the threshold
 * - The full payout amount if already above threshold
 */
export async function calculateTDS(params: {
  consultantProfileId: string;
  payoutAmountPaise: number;
}): Promise<TDSCalculationResult> {
  const { consultantProfileId, payoutAmountPaise } = params;
  const financialYear = getIndianFinancialYear();

  // Fetch tax info early for residency check + PAN verification
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
  });

  // Non-resident guard: Section 194J does not apply to non-residents.
  // Non-residents would need Section 195 (international withholding) which is not yet supported.
  if (taxInfo && !taxInfo.isIndianResident) {
    const cumulativeBeforePayout =
      await getCurrentFYCumulativePayments(consultantProfileId);
    return {
      tdsAmount: 0,
      tdsRate: 0,
      isAboveThreshold: false,
      cumulativeBeforePayout,
      cumulativeAfterPayout: cumulativeBeforePayout + payoutAmountPaise,
      financialYear,
    };
  }

  // Get cumulative payments for this FY
  const cumulativeBeforePayout =
    await getCurrentFYCumulativePayments(consultantProfileId);
  const cumulativeAfterPayout = cumulativeBeforePayout + payoutAmountPaise;

  // Below threshold — no TDS
  if (cumulativeAfterPayout <= TDS_THRESHOLD_PAISE) {
    return {
      tdsAmount: 0,
      tdsRate: 0,
      isAboveThreshold: false,
      cumulativeBeforePayout,
      cumulativeAfterPayout,
      financialYear,
    };
  }

  const tdsRate = taxInfo?.panVerified
    ? TDS_RATE_WITH_PAN
    : TDS_RATE_WITHOUT_PAN;

  // Calculate taxable amount
  let taxableAmount: number;

  if (cumulativeBeforePayout >= TDS_THRESHOLD_PAISE) {
    // Already above threshold — TDS on full payout
    taxableAmount = payoutAmountPaise;
  } else {
    // Crossing threshold this payout — TDS only on excess
    taxableAmount = cumulativeAfterPayout - TDS_THRESHOLD_PAISE;
  }

  const tdsAmount = Math.round((taxableAmount * tdsRate) / 100);

  return {
    tdsAmount,
    tdsRate,
    isAboveThreshold: true,
    cumulativeBeforePayout,
    cumulativeAfterPayout,
    financialYear,
  };
}

/**
 * Record a TDS deduction.
 * Called after payout is processed to create an audit trail.
 */
export async function recordTDSDeduction(params: {
  consultantProfileId: string;
  financialYear: string;
  tdsDeducted: number;
  tdsRate: number;
  cumulativeAmountCredited: number;
  payoutId?: string;
  earningsId?: string;
  db?: Prisma.TransactionClient | typeof prisma;
}) {
  const quarter = getIndianFYQuarter();

  const db = params.db || prisma;

  return db.tDSRecord.create({
    data: {
      consultantProfileId: params.consultantProfileId,
      financialYear: params.financialYear,
      quarter,
      cumulativeAmountCredited: params.cumulativeAmountCredited,
      tdsDeducted: params.tdsDeducted,
      tdsRate: params.tdsRate,
      payoutId: params.payoutId,
      earningsId: params.earningsId,
    },
  });
}

// ============================================================================
// Admin Queries
// ============================================================================

/**
 * Get TDS summary for a financial year.
 */
export async function getTDSSummary(financialYear: string) {
  const records = await prisma.tDSRecord.groupBy({
    by: ["quarter"],
    where: { financialYear },
    _sum: { tdsDeducted: true },
    _count: true,
  });

  const totalDeducted = await prisma.tDSRecord.aggregate({
    where: { financialYear },
    _sum: { tdsDeducted: true },
    _count: true,
  });

  const unfiled = await prisma.tDSRecord.count({
    where: { financialYear, reportedInForm26Q: false },
  });

  return {
    financialYear,
    quarterWise: records.map((r) => ({
      quarter: r.quarter,
      totalDeducted: r._sum.tdsDeducted || 0,
      count: r._count,
    })),
    totalDeducted: totalDeducted._sum.tdsDeducted || 0,
    totalRecords: totalDeducted._count,
    unfiledRecords: unfiled,
  };
}

/**
 * Get per-consultant TDS breakdown for a financial year.
 */
export async function getConsultantTDSBreakdown(financialYear: string) {
  return prisma.tDSRecord.groupBy({
    by: ["consultantProfileId", "tdsRate"],
    where: { financialYear },
    _sum: { tdsDeducted: true, cumulativeAmountCredited: true },
    _count: true,
    orderBy: { _sum: { tdsDeducted: "desc" } },
  });
}

/**
 * Mark TDS records as filed in Form 26Q.
 */
export async function markTDSAsFiled(params: {
  financialYear: string;
  quarter: number;
  filingDate: Date;
}) {
  return prisma.tDSRecord.updateMany({
    where: {
      financialYear: params.financialYear,
      quarter: params.quarter,
      reportedInForm26Q: false,
    },
    data: {
      reportedInForm26Q: true,
      form26QFilingDate: params.filingDate,
    },
  });
}
