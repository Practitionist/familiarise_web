/**
 * MSME (Micro, Small, Medium Enterprises) payment-deadline computation —
 * INDIA COMPLIANCE STUB.
 *
 * STATUS: stub. Returns a safe default mustPayByDate so downstream code
 * doesn't null-crash. Live derivation lands in a follow-up PR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Section 43B(h) of the Income Tax Act (inserted by Finance Act 2023):
 *
 *   - Payments to MSME-registered suppliers must be made within:
 *       * 15 days of invoice date if there is NO written agreement
 *       * 45 days of invoice date if there IS a written agreement
 *
 *   - If breached, the buyer cannot claim the expense as a tax deduction
 *     in the current year — it is disallowed until actually paid.
 *
 *   - Applies to:
 *       * MICRO enterprises (investment ≤ ₹2.5 Cr, turnover ≤ ₹10 Cr)
 *       * SMALL enterprises (investment ≤ ₹25 Cr, turnover ≤ ₹100 Cr)
 *       * NOT MEDIUM and NOT non-MSME — those keep 30-day default.
 *
 *   - Source of truth: `ConsultantProfile.msmeStatus` + `udyamNumber` +
 *     `writtenAgreementWithFamiliarise`.
 *
 * Live impl should:
 *   1. Read invoice/payment creation date.
 *   2. Read ConsultantProfile.msmeStatus:
 *        - NONE or MEDIUM → 60-day default (org paymentTermsDays).
 *        - MICRO or SMALL → 15 or 45 days depending on agreement flag.
 *   3. Compute mustPayByDate = creationDate + deadlineDays.
 *   4. Store on Payout.mustPayByDate.
 *   5. A daily cron job (`jobs/compliance/msme-payment-alerts.ts`) sweeps
 *      rows where `mustPayByDate - now < 5 days AND status != SUCCEEDED`
 *      and surfaces them to finance for settlement.
 *
 * Udyam number format: UDYAM-XX-NN-NNNNNNN (19 chars).
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { MsmeStatus } from "@prisma/client";

/**
 * STUB: Computes the deadline by which a payment to this provider must be
 * settled to remain compliant with Section 43B(h).
 *
 * @returns ISO date string for the payment deadline.
 *
 * TODO: replace with live derivation per the header docblock.
 */
export function computeMsmePaymentDeadline(params: {
  invoiceDate: Date;
  msmeStatus: MsmeStatus;
  writtenAgreement: boolean;
  defaultTermsDays?: number;
}): Date {
  // STUB: always returns invoiceDate + 60 days (the org default).
  const days = params.defaultTermsDays ?? 60;
  const d = new Date(params.invoiceDate);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * STUB: Validates an Udyam registration number format.
 */
export function isValidUdyamNumber(n: string | null | undefined): boolean {
  if (!n) return false;
  return /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(n);
}
