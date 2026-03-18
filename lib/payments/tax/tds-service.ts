/**
 * TDS (Tax Deducted at Source) Service — Section 194J
 *
 * Handles TDS calculation, deduction, and record-keeping for consultant payouts.
 *
 * Rules:
 * - Threshold: ₹50,000/financial year (April–March)
 * - Rate: 10% with verified PAN, 20% without PAN
 * - Applies to professional/technical services (Section 194J)
 * - Must be deposited by 7th of next month
 * - Quarterly filing: Form 26Q
 */

import prisma from "@/lib/prisma";

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
 * Get cumulative gross payments to a consultant for the current FY.
 * This is the sum of all consultant earnings (grossAmount) for the FY.
 */
export async function getCurrentFYCumulativePayments(
  consultantProfileId: string,
  financialYear?: string,
): Promise<number> {
  const fy = financialYear || getIndianFinancialYear();
  const { start, end } = getFYDateRange(fy);

  const result = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      createdAt: { gte: start, lte: end },
      status: { not: "REFUNDED" },
    },
    _sum: { grossAmount: true },
  });

  return result._sum.grossAmount || 0;
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
  /** Cumulative gross payments for FY (BEFORE this payout), in paise */
  cumulativeBeforePayout: number;
  /** Cumulative gross payments for FY (AFTER this payout), in paise */
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

  // Determine TDS rate based on PAN verification
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
  });

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
  cumulativeGrossPayments: number;
  payoutId?: string;
  earningsId?: string;
}) {
  const quarter = getIndianFYQuarter();

  return prisma.tDSRecord.create({
    data: {
      consultantProfileId: params.consultantProfileId,
      financialYear: params.financialYear,
      quarter,
      cumulativeGrossPayments: params.cumulativeGrossPayments,
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
    _sum: { tdsDeducted: true, cumulativeGrossPayments: true },
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
