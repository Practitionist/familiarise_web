/** Which rail a booking's money travels on, in or out. */
export type FundingRail = "GATEWAY" | "INTERNAL" | "CREDITS";

/** Org-funded bookings carry a synthetic paymentIntent no gateway can refund. */
export function isInternalFundedIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith("org_");
}

/** Fully credit-funded bookings — zero gateway money, credits to restore. */
export function isFreeCreditIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith("free_");
}

/**
 * The rail a payment refunds on, decided before anything moves, so the
 * cancellation quote and the refund itself can never name different rails.
 */
export function fundingRailForIntent(
  paymentIntent: string | null | undefined,
): FundingRail {
  if (!paymentIntent) return "GATEWAY";
  if (isFreeCreditIntent(paymentIntent)) return "CREDITS";
  if (isInternalFundedIntent(paymentIntent)) return "INTERNAL";
  return "GATEWAY";
}
