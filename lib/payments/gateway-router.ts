/**
 * Gateway Auto-Router
 *
 * Automatically selects the optimal payment gateway based on buyer country.
 * Strategy: Razorpay for everything (domestic + IBT for international).
 * Stripe is a fenced contingency rail: an explicit request is honoured only
 * when STRIPE_ENABLED=true, and auto-routing never selects it (#1351).
 *
 * Cost comparison:
 * - Razorpay domestic: 2% + GST (~2.36%)
 * - Razorpay IBT (international): 1% + GST, zero forex markup
 * - Stripe international: ~6.3% (4.3% processing + 2% currency conversion)
 */

import type { SupportedCheckoutGateway } from "@/schemas/checkout";
import { assertGatewayUsable } from "@/lib/payments/validation/gateway-guards";

export interface GatewayRoutingResult {
  /** Selected payment gateway — always an implemented gateway, never a stub */
  gateway: SupportedCheckoutGateway;
  /** Human-readable reason for the selection (for audit logs) */
  reason: string;
  /** Whether this is a Razorpay International Bank Transfer */
  isIBT: boolean;
  /** Currency to charge in (always INR for Razorpay) */
  currency: string;
}

/**
 * Route to the optimal payment gateway based on buyer country and preferences.
 *
 * Rules:
 * 1. India buyers → Razorpay domestic (cheapest, UPI support)
 * 2. International buyers → Razorpay IBT (1% + GST, zero forex, auto eFIRC)
 * 3. Client explicitly requests STRIPE → honour it only when the fence is
 *    open (STRIPE_ENABLED=true); assertGatewayUsable throws otherwise
 * 4. Fallback: Razorpay
 */
export function routeGateway(params: {
  buyerCountry: string;
  requestedGateway?: SupportedCheckoutGateway;
}): GatewayRoutingResult {
  const { buyerCountry, requestedGateway } = params;

  // `SupportedCheckoutGateway` already excludes the post-MVP stubs, so the stub
  // half of this is unreachable through a type-checked caller. It exists
  // because the value originates in a JSON request body: if the Zod enum in
  // schemas/checkout.ts is ever widened to the full Prisma enum "for
  // convenience", the type stops protecting us and a stub reaches order
  // creation. The Stripe half is reachable today — STRIPE is a valid checkout
  // gateway in the schema — and is what fences the contingency rail.
  if (requestedGateway) {
    assertGatewayUsable(requestedGateway, "route a checkout");
  }

  // Honour an explicit STRIPE request. Only reachable when STRIPE_ENABLED=true;
  // the guard above has already thrown otherwise (#1351). Auto-routing below
  // never picks Stripe, so this branch is the sole way to reach it.
  if (requestedGateway === "STRIPE") {
    return {
      gateway: "STRIPE",
      reason: `Client explicitly requested Stripe (buyer: ${buyerCountry})`,
      isIBT: false,
      currency: "INR",
    };
  }

  // India — Razorpay domestic
  if (buyerCountry === "IN") {
    return {
      gateway: "RAZORPAY",
      reason: "Domestic India buyer — Razorpay (UPI + cards, 2% + GST)",
      isIBT: false,
      currency: "INR",
    };
  }

  // International — Razorpay IBT (much cheaper than Stripe)
  return {
    gateway: "RAZORPAY",
    reason: `International buyer (${buyerCountry}) — Razorpay IBT (1% + GST, zero forex, auto eFIRC)`,
    isIBT: true,
    currency: "INR", // Razorpay always settles in INR
  };
}
