/**
 * What a buyer's picked time turns into at each door: the consultation
 * checkout URL, the request-for-approval body and the trial body. Checkout and
 * the request door need the availability row the time was cut from.
 */

import type { AvailabilityWindowRef } from "@/lib/scheduling/single-session-options";

export interface PickedTime {
  startsAt: string;
  endsAt: string;
  window?: AvailabilityWindowRef;
}

/** `availabilityWindowWeeklyId` or `availabilityWindowCustomId`, whichever row the pick came from. */
export function pickedWindowFields(
  pick: PickedTime,
):
  | { availabilityWindowWeeklyId: string }
  | { availabilityWindowCustomId: string }
  | Record<string, never> {
  if (!pick.window) return {};
  return pick.window.type === "WEEKLY"
    ? { availabilityWindowWeeklyId: pick.window.id }
    : { availabilityWindowCustomId: pick.window.id };
}

export function consultationCheckoutHref(
  planId: string,
  pick: PickedTime,
): string {
  const params = new URLSearchParams({
    ...pickedWindowFields(pick),
    startsAt: pick.startsAt,
    endsAt: pick.endsAt,
  });
  return `/checkout/plans/consultation/${planId}?${params.toString()}`;
}

export function requestForApprovalBody(args: {
  consultantProfileId: string;
  consultationPlanId: string;
  pick: PickedTime;
}) {
  return {
    consultantProfileId: args.consultantProfileId,
    consultationPlanId: args.consultationPlanId,
    startsAt: args.pick.startsAt,
    endsAt: args.pick.endsAt,
    ...pickedWindowFields(args.pick),
  };
}

export function trialCreateBody(args: {
  consulteeProfileId: string;
  consultantProfileId: string;
  subscriptionPlanId: string;
  notes?: string;
  pick: PickedTime;
}) {
  return {
    consulteeProfileId: args.consulteeProfileId,
    consultantProfileId: args.consultantProfileId,
    subscriptionPlanId: args.subscriptionPlanId,
    notes: args.notes,
    slot: { startsAt: args.pick.startsAt, endsAt: args.pick.endsAt },
  };
}
