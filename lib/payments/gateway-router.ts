/**
 * Gateway Auto-Router
 *
 * Automatically selects the optimal payment gateway based on buyer country.
 * Strategy: Razorpay for everything (domestic + IBT for international).
 * Stripe as fallback only when explicitly requested.
 *
 * Cost comparison:
 * - Razorpay domestic: 2% + GST (~2.36%)
 * - Razorpay IBT (international): 1% + GST, zero forex markup
 * - Stripe international: ~6.3% (4.3% processing + 2% currency conversion)
 */

import { PaymentGateway } from "@prisma/client";

export interface GatewayRoutingResult {
  /** Selected payment gateway */
  gateway: PaymentGateway;
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
 * 3. Client explicitly requests STRIPE → honor it (for testing/edge cases)
 * 4. Fallback: Razorpay
 */
export function routeGateway(params: {
  buyerCountry: string;
  requestedGateway?: PaymentGateway;
}): GatewayRoutingResult {
  const { buyerCountry, requestedGateway } = params;

  // Honor explicit STRIPE request (for testing or when Razorpay is unavailable)
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
