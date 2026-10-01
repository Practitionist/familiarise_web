/**
 * #1771 — plain labels for the money enums the operator hub shows, so no raw
 * enum text reaches the DOM. Unknown values fall back to title case.
 */

import type { PaymentGateway, PayoutMethod } from "@prisma/client";

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
export const payoutMethodLabel = (v: string | null | undefined) =>
  label(PAYOUT_METHOD_LABEL, v);
export const fundingRailLabel = (v: string | null | undefined) =>
  label(FUNDING_RAIL_LABEL, v);
/** Any other status-like enum (class, seat, role, job run). */
export const enumLabel = (v: string | null | undefined) => label({}, v);
