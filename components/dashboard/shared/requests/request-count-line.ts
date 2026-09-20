import type { SubscriptionEntitlement } from "@/lib/booking/entitlement";

/**
 * One short line under a request's title (#1766): a subscription reads its
 * entitlement words, never a bare slot count; anything else keeps the slot
 * phrasing the allocator validates against.
 */
export function requestCountLine(request: {
  requiredSlots?: number;
  entitlement?: SubscriptionEntitlement;
}): string {
  if (request.entitlement) {
    const { held, total, cycle } = request.entitlement;
    return `${held} of ${total} booked · pick ${cycle.nextBatch}`;
  }
  if (request.requiredSlots === undefined) return "Slot count unavailable";
  return `${request.requiredSlots} slot${request.requiredSlots !== 1 ? "s" : ""} to allocate`;
}
