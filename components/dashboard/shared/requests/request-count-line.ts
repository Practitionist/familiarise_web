import type { SubscriptionEntitlement } from "@/lib/booking/entitlement";

/**
 * One short line under a subscription request's title (#1766): its
 * entitlement words, never a bare slot count. The inbox and the Home
 * preview are the only callers, and both hand it an entitlement.
 */
export function requestCountLine(request: {
  entitlement: SubscriptionEntitlement;
}): string {
  const { held, total, cycle } = request.entitlement;
  return `${held} of ${total} booked · pick ${cycle.nextBatch}`;
}
