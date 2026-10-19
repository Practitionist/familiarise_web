import type { AccountRef } from "@/lib/payments/ledger/post";

/**
 * The account a Razorpay PG capture, gateway refund or chargeback moves. The
 * settlement job later moves its settled net to CASH; RazorpayX payouts stay on CASH.
 */
export function gatewayCashAccount(): AccountRef {
  return { kind: "GATEWAY_CLEARING" };
}
