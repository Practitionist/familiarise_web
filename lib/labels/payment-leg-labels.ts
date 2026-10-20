import type { PaymentLegSource } from "@prisma/client";

/**
 * The payer's words for each funding rail on a charge. Keyed by the real enum
 * so a new `PaymentLegSource` is a type error here rather than a raw enum name
 * on the learner's payment page. Reversal legs carry negative amounts.
 */
export const PAYMENT_LEG_SOURCE_LABEL: Record<PaymentLegSource, string> = {
  CARD: "Card / UPI",
  WALLET: "Organisation wallet",
  REFERRAL_CREDIT: "Referral credit",
  INVOICE_ACCRUAL: "Billed to your organisation",
  OVERAGE_INVOICE_ACCRUAL: "Extra charge billed to your organisation",
  LICENSE: "Covered by your organisation's licence",
  INVOICE_ACCRUAL_REVERSAL: "Refund of the amount billed to your organisation",
  OVERAGE_INVOICE_ACCRUAL_REVERSAL:
    "Refund of the extra charge billed to your organisation",
};

export function paymentLegLabel(source: PaymentLegSource): string {
  return PAYMENT_LEG_SOURCE_LABEL[source];
}
