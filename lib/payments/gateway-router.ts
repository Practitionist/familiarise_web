/**
 * Gateway Auto-Router
 *
 * Razorpay serves every buyer, domestic and international alike. Every route
 * mints an ordinary INR order; an overseas buyer pays it with an overseas card
 * and their issuer converts, so `assertInrSettlement` stays an unconditional
 * assertion at order creation.
 *
 * Cost: Razorpay domestic ~2% + GST; international cards ~3% + GST on the same
 * INR order.
 */

import type { SupportedCheckoutGateway } from "@/schemas/checkout";
import { assertGatewayUsable } from "@/lib/payments/validation/gateway-guards";

export interface GatewayRoutingResult {
  /** Selected payment gateway — always an implemented gateway, never a stub */
  gateway: SupportedCheckoutGateway;
  /** Human-readable reason for the selection (for audit logs) */
  reason: string;
  /** Currency to charge in — always INR; settlement is INR-only (ADR 15) */
  currency: string;
}

/**
 * Route to the payment gateway for a buyer country.
 *
 * 1. India buyers → Razorpay domestic (UPI + cards)
 * 2. International buyers → Razorpay, still on an INR order, paid by an
 *    overseas card at Razorpay's international card pricing (~3% + GST)
 */
export function routeGateway(params: {
  buyerCountry: string;
  requestedGateway?: SupportedCheckoutGateway;
}): GatewayRoutingResult {
  const { buyerCountry, requestedGateway } = params;

  // The value originates in a JSON request body, so guard it even though the
  // type already excludes every gateway without an implementation.
  if (requestedGateway) {
    assertGatewayUsable(requestedGateway, "route a checkout");
  }

  // India — Razorpay domestic
  if (buyerCountry === "IN") {
    return {
      gateway: "RAZORPAY",
      reason: "Domestic India buyer — Razorpay (UPI + cards, 2% + GST)",
      currency: "INR",
    };
  }

  // International — still Razorpay, still an INR order; the buyer's card issuer
  // does the conversion at international card pricing (~3% + GST).
  return {
    gateway: "RAZORPAY",
    reason: `International buyer (${buyerCountry}) — Razorpay INR order on an overseas card (~3% + GST)`,
    currency: "INR", // Razorpay always settles in INR
  };
}
