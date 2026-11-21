/**
 * #1771 — plain labels for the money enums the operator hub shows, so no raw
 * enum text reaches the DOM. Unknown values fall back to title case.
 */

import type {
  DisputeStatus,
  LedgerAccountKind,
  LedgerDirection,
  LedgerTransactionKind,
  PaymentGateway,
  PayoutMethod,
} from "@prisma/client";

import { formatStatusLabel } from "./session-labels";

export const PAYMENT_GATEWAY_LABEL: Record<PaymentGateway, string> = {
  STRIPE: "Stripe",
  RAZORPAY: "Razorpay",
  DODO_PAYMENTS: "Dodo Payments",
  CARD: "Card",
};

export const PAYOUT_METHOD_LABEL: Record<PayoutMethod, string> = {
  BANK_TRANSFER: "Bank transfer",
  UPI: "UPI",
  STRIPE_TRANSFER: "Stripe transfer",
};

/** Why an organisation wallet balance moved, in the words its admins use. */
export const WALLET_REASON_LABEL = {
  TOPUP: "Top-up",
  BOOKING: "Session booked",
  OVERAGE_SURCHARGE: "Extra-session surcharge",
  REFUND: "Refund or chargeback",
  TOPUP_REFUND: "Top-up refunded",
  TOPUP_REFUND_SHORTFALL:
    "Refunded top-up already spent: added to the amount owed",
  INVOICE_REFUND: "Invoice refunded to wallet",
  OVERAGE_MEMBER_BILLED:
    "Returned to the wallet: a member is billed for their extra session",
  OVERAGE_MEMBER_UNPAID:
    "Paid by the wallet: a member's extra-session charge went unpaid",
  WALLET_ADJUSTMENT: "Adjustment by our team",
} as const satisfies Record<string, string>;

export type WalletEntryReason = keyof typeof WALLET_REASON_LABEL;

/** Key prefix of the part of a top-up refund the wallet could not cover, booked as owed by the org. */
export const TOPUP_REFUND_SHORTFALL_KEY_PREFIX = "topup-refund-shortfall:";

/** The stored facts that name one line on an organisation's WALLET journal. */
export interface WalletJournalLine {
  direction: LedgerDirection;
  transaction: { kind: LedgerTransactionKind; idempotencyKey: string };
}

/**
 * A wallet line's reason from its posting's subtype (idempotency-key prefix) and direction.
 * An unlisted kind passes through and is title-cased by `walletReasonLabel`.
 */
export function walletEntryReason(
  line: WalletJournalLine,
): WalletEntryReason | LedgerTransactionKind {
  const { kind, idempotencyKey } = line.transaction;
  if (kind === "BOOKING" && idempotencyKey.startsWith("overage-accrual:")) {
    return "OVERAGE_SURCHARGE";
  }
  if (
    kind === "TOPUP_REFUND" &&
    idempotencyKey.startsWith(TOPUP_REFUND_SHORTFALL_KEY_PREFIX)
  ) {
    return "TOPUP_REFUND_SHORTFALL";
  }
  if (kind === "OVERAGE_MEMBER") {
    return line.direction === "CREDIT"
      ? "OVERAGE_MEMBER_BILLED"
      : "OVERAGE_MEMBER_UNPAID";
  }
  return kind;
}

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  WARNING_NEEDS_RESPONSE: "Early warning, needs a response",
  WARNING_UNDER_REVIEW: "Early warning, under review",
  WARNING_CLOSED: "Early warning, closed",
  NEEDS_RESPONSE: "Needs a response",
  UNDER_REVIEW: "Under review",
  CHARGE_REFUNDED: "Refunded",
  WON: "Won",
  LOST: "Lost",
  CLOSED: "Closed",
};

const DISPUTE_REASON_LABEL: Record<string, string> = {
  fraudulent: "Fraudulent payment claim",
  product_not_received: "Goods never arrived",
  product_unacceptable: "Goods not as described",
  subscription_canceled: "Cancelled subscription",
  credit_not_processed: "Credit never processed",
  unrecognized: "Charge not recognised",
  duplicate: "Duplicate charge",
  general: "General dispute",
};

/** A dispute reason: gateway codes become words, free text a person wrote passes through. */
export function disputeReasonText(reason: string | null | undefined): string {
  const raw = reason?.trim();
  if (!raw) return "No reason given";
  const key = raw.toLowerCase();
  if (Object.hasOwn(DISPUTE_REASON_LABEL, key))
    return DISPUTE_REASON_LABEL[key];
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(raw)) return raw;
  const words = key.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The double-entry account kinds, as an operator reads a ledger posting. */
export const LEDGER_ACCOUNT_LABEL: Record<LedgerAccountKind, string> = {
  CASH: "Cash",
  WALLET: "Organisation wallet",
  PLATFORM_FEE: "Platform fee",
  PLATFORM_PROMO: "Platform promotions",
  REFERRAL_CREDIT_LIABILITY: "Referral credit owed",
  DISCOUNT: "Discounts",
  CONSULTANT_PAYABLE: "Owed to expert",
  ORG_PAYABLE: "Owed to organisation",
  ORG_RECEIVABLE: "Owed by organisation",
  CONSULTANT_RECEIVABLE: "Owed by expert",
  TDS_PAYABLE: "TDS owed",
  GST_PAYABLE: "GST owed",
  UNAPPLIED_RECEIPTS: "Unapplied receipts",
  GATEWAY_CLEARING: "Gateway clearing",
  GATEWAY_FEE: "Gateway fees",
  GST_INPUT_CREDIT: "GST input credit",
};

/** Subscription plan statuses come off the wire in lower case. */
export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** The three refund rails (booking-refund.ts FundingRail), in buyer words. */
export const FUNDING_RAIL_LABEL: Record<string, string> = {
  GATEWAY: "Card or UPI",
  INTERNAL: "Organisation",
  CREDITS: "Credits",
};

function label(map: Record<string, string>, value: string | null | undefined) {
  if (!value) return "Unknown";
  return map[value] ?? formatStatusLabel(value);
}

export const gatewayLabel = (v: string | null | undefined) =>
  label(PAYMENT_GATEWAY_LABEL, v);
export const ledgerAccountLabel = (v: string | null | undefined) =>
  label(LEDGER_ACCOUNT_LABEL, v);
export const payoutMethodLabel = (v: string | null | undefined) =>
  label(PAYOUT_METHOD_LABEL, v);
export const walletReasonLabel = (v: string | null | undefined) =>
  label(WALLET_REASON_LABEL, v);
export const disputeStatusLabel = (v: string | null | undefined) =>
  label(DISPUTE_STATUS_LABEL, v);
export const subscriptionStatusLabel = (v: string | null | undefined) =>
  label(SUBSCRIPTION_STATUS_LABEL, v?.toLowerCase());
export const fundingRailLabel = (v: string | null | undefined) =>
  label(FUNDING_RAIL_LABEL, v);
/** Any other status-like enum (class, seat, role, job run). */
export const enumLabel = (v: string | null | undefined) => label({}, v);
