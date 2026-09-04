/**
 * Gateway Auto-Router
 *
 * Automatically selects the optimal payment gateway based on buyer country.
 * Strategy: Razorpay for everything, domestic and international alike. Stripe
 * is a fallback used only when the client explicitly asks for it.
 *
 * Every route below mints an ordinary INR order. An overseas buyer pays that
 * INR order with an overseas card, and their issuer converts; the platform
 * never denominates anything in a foreign currency, which is why
 * `assertInrSettlement` can be an unconditional assertion at order creation.
 *
 * Cost comparison:
 * - Razorpay domestic: 2% + GST (~2.36%)
 * - Razorpay international cards: ~3% + GST on the same INR order
 * - Stripe international: ~6.3% (4.3% processing + 2% currency conversion)
 *
 * #1396 — this header used to advertise "Razorpay IBT (1% + GST, zero forex,
 * auto eFIRC)" for international buyers, and the routing result carried a
 * matching boolean that nothing ever read. That was wrong on the product, not just on the number. IBT is the
 * MoneySaver Export Account, a virtual-account bank-transfer product with no
 * Orders API behind it
 * (https://razorpay.com/docs/payments/international-payments/international-bank-transfer/),
 * so no checkout in this codebase has ever routed through it. Quoting 1% here
 * understated the real international take rate by roughly two points in every
 * margin conversation that cited this file.
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
 * Route to the optimal payment gateway based on buyer country and preferences.
 *
 * Rules:
 * 1. India buyers → Razorpay domestic (cheapest, UPI support)
 * 2. International buyers → Razorpay, still on an INR order, paid by an
 *    overseas card at Razorpay's international card pricing (~3% + GST)
 * 3. Client explicitly requests STRIPE → honor it (for testing/edge cases)
 * 4. Fallback: Razorpay
 */
export function routeGateway(params: {
  buyerCountry: string;
  requestedGateway?: SupportedCheckoutGateway;
}): GatewayRoutingResult {
  const { buyerCountry, requestedGateway } = params;

  // `SupportedCheckoutGateway` already excludes the post-MVP stubs, so this is
  // unreachable through a type-checked caller. It exists because the value
  // originates in a JSON request body: if the Zod enum in schemas/checkout.ts
  // is ever widened to the full Prisma enum "for convenience", the type stops
  // protecting us and a stub reaches order creation. Failing here is cheap.
  if (requestedGateway) {
    assertGatewayUsable(requestedGateway, "route a checkout");
  }

  // Honor explicit STRIPE request (for testing or when Razorpay is unavailable)
  if (requestedGateway === "STRIPE") {
    return {
      gateway: "STRIPE",
      reason: `Client explicitly requested Stripe (buyer: ${buyerCountry})`,
      currency: "INR",
    };
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
  // does the conversion. Cheaper than Stripe, but at international card pricing
  // (~3% + GST), not the IBT rate this branch used to claim.
  return {
    gateway: "RAZORPAY",
    reason: `International buyer (${buyerCountry}) — Razorpay INR order on an overseas card (~3% + GST)`,
    currency: "INR", // Razorpay always settles in INR
  };
}
