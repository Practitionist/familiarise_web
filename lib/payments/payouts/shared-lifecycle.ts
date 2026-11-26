/**
 * Shared payout lifecycle primitives across the individual consultant rail
 * (`payout-service.ts`) and the organization rail (`org-payout-service.ts`).
 */

import type { Prisma } from "@prisma/client";
import { computeMsmePaymentDeadline } from "@/lib/compliance/msme";
import { computeTdsForPayout } from "@/lib/compliance/tds";
import type { Posting } from "@/lib/payments/ledger/post";
import {
  getFYDateRange,
  getIndianFinancialYear,
  getIndianFYQuarter,
} from "@/lib/payments/tax/tds-service";
import { MONEY_OWED_PAYMENT } from "@/scripts/earnings/release-earnings";
import { isDefinitiveGatewayRejection } from "./razorpay-payouts";

/** Claim gate, both payout rails: an active dispute on an earning's payment blocks the payout. */
export const DISPUTE_GATED_PAYMENT_WHERE = MONEY_OWED_PAYMENT.activeDispute;

/** Claim gate, both payout rails: a refund in flight or still owed on an earning's payment blocks the payout. */
export const REFUND_GATED_PAYMENT_WHERE = {
  OR: [MONEY_OWED_PAYMENT.refundInFlight, MONEY_OWED_PAYMENT.refundOwed],
} satisfies Prisma.PaymentWhereInput;

export type PayableLedgerAccount =
  | { kind: "CONSULTANT_PAYABLE"; consultantProfileId: string }
  | { kind: "ORG_PAYABLE"; organizationId: string };

/**
 * Builds the balanced journal postings for a payout completion (`COMPLETED`):
 *   DEBIT  <CONSULTANT_PAYABLE | ORG_PAYABLE> = grossPayablePaise
 *   CREDIT CASH (when netCashPaise > 0)       = netCashPaise
 *   CREDIT TDS_PAYABLE = tdsPaise, or DEBIT it when tdsPaise < 0 (excess TDS credited back)
 */
export function buildPayoutCompletionPostings(params: {
  payableAccount: PayableLedgerAccount;
  grossPayablePaise: number;
  netCashPaise: number;
  tdsPaise: number;
}): Posting[] {
  return payoutPostings(params, "DEBIT");
}

/**
 * Builds the symmetric reversal postings when a previously `COMPLETED` payout
 * reverses (`payout.reversed` after completion): every completion posting with
 * its direction flipped.
 */
export function buildPayoutReversalPostings(params: {
  payableAccount: PayableLedgerAccount;
  grossPayablePaise: number;
  netCashPaise: number;
  tdsPaise: number;
}): Posting[] {
  return payoutPostings(params, "CREDIT");
}

function payoutPostings(
  params: {
    payableAccount: PayableLedgerAccount;
    grossPayablePaise: number;
    netCashPaise: number;
    tdsPaise: number;
  },
  payableDirection: "DEBIT" | "CREDIT",
): Posting[] {
  const opposite = payableDirection === "DEBIT" ? "CREDIT" : "DEBIT";
  const payable: Posting = {
    account: params.payableAccount,
    direction: payableDirection,
    amountPaise: params.grossPayablePaise,
  };
  const cash: Posting[] =
    params.netCashPaise > 0
      ? [
          {
            account: { kind: "CASH" },
            direction: opposite,
            amountPaise: params.netCashPaise,
          },
        ]
      : [];
  // Completions list the payable first and reversals list cash first.
  const postings: Posting[] =
    payableDirection === "DEBIT" ? [payable, ...cash] : [...cash, payable];
  if (params.tdsPaise !== 0) {
    postings.push({
      account: { kind: "TDS_PAYABLE" },
      direction: params.tdsPaise > 0 ? opposite : payableDirection,
      amountPaise: Math.abs(params.tdsPaise),
    });
  }
  return postings;
}

export interface CompletionTdsWindow {
  completedAt: Date;
  financialYear: string;
  quarter: number;
  start: Date;
  end: Date;
}

/**
 * Resolves the statutory Indian financial year and quarter at the completion
 * timestamp so Form 26Q attribution uses the actual settlement date rather
 * than the batch creation date.
 */
export function resolveCompletionTdsWindow(
  completedAt: Date = new Date(),
): CompletionTdsWindow {
  const financialYear = getIndianFinancialYear(completedAt);
  const quarter = getIndianFYQuarter(completedAt);
  const { start, end } = getFYDateRange(financialYear);
  return { completedAt, financialYear, quarter, start, end };
}

/**
 * Converts a decimal TDS rate fraction (e.g. `0.001` for 0.1%, `0.10` for 10%)
 * into integer basis points (`10` bps = 0.1%, `1000` bps = 10%).
 */
export function tdsRateToBps(tdsRate: number): number {
  return Math.round(tdsRate * 10_000);
}

/**
 * Computes statutory Section 194-O TDS for an Indian-resident payee from whether
 * a PAN is on file (plaintext PAN decryption is deferred to Form 26Q filing).
 */
export function computeResidentPayoutTds(
  grossAmountPaise: number,
  panOnFile: boolean,
  resolvedRate?: Parameters<typeof computeTdsForPayout>[0]["resolvedRate"],
) {
  return computeTdsForPayout({
    grossAmountPaise,
    consultant: {
      panNumber: null,
      panOnFile,
      residencyStatus: "RESIDENT",
      tdsSection: null,
      tdsRateBps: null,
      tdsLowerRateCert: null,
      providerCountry: null,
    },
    resolvedRate,
  });
}

/**
 * #1902 — Raised when the admin attempting to approve a payout is the same
 * admin who created it (`createdBy === adminUserId`) and dual-control
 * maker-checker enforcement is active.
 */
export class PayoutMakerCheckerError extends Error {
  readonly httpStatus = 403;
  readonly code = "PAYOUT_MAKER_CHECKER_VIOLATION";
  constructor(
    message = "Maker-checker violation: a payout cannot be approved by the same admin who created it.",
  ) {
    super(message);
    this.name = "PayoutMakerCheckerError";
  }
}

/**
 * Computes the MSMED Act Section 15 payment deadline for a consultant or
 * organization payout.
 */
export function resolvePayoutMsmeDeadline(
  msmeStatus:
    | Parameters<typeof computeMsmePaymentDeadline>[0]["counterpartyMsmeStatus"]
    | null
    | undefined,
  writtenAgreement: boolean | null | undefined,
  invoiceDate: Date = new Date(),
): Date | null {
  return computeMsmePaymentDeadline({
    invoiceDate,
    counterpartyMsmeStatus: msmeStatus ?? "NONE",
    writtenAgreement: writtenAgreement ?? false,
  });
}

export type GatewaySubmissionFailureClass =
  "PERMANENT_4XX" | "TRANSIENT_OR_UNKNOWN";

/**
 * Classifies a gateway payout submission error as a definitive 4xx rejection
 * (`PERMANENT_4XX`, safe to transition to `FAILED` and release earnings) vs.
 * an ambiguous/transient failure (`TRANSIENT_OR_UNKNOWN`, keep `PROCESSING`
 * for reconciliation or retry with the same idempotency key).
 */
export function classifyGatewaySubmissionError(
  err: unknown,
): GatewaySubmissionFailureClass {
  return isDefinitiveGatewayRejection(err)
    ? "PERMANENT_4XX"
    : "TRANSIENT_OR_UNKNOWN";
}
