/**
 * The host's hours as one predicate over a session, with the allocator's own
 * contract: weekly rows through their zone, custom rows merged (a multi-day
 * row covers every day it spans), every 30-minute atom of the session inside.
 */
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { isWithinAvailability } from "@/lib/booking/allocation/search/window-walk";
import type { AllocationWalkContext } from "@/lib/booking/allocation/search/constants";
import type { ConsultantAllocationData } from "@/utils/scheduling-engine/types";

export function hostHoursPredicate(
  consultant: ConsultantAllocationData,
): (startsAt: Date, endsAt: Date) => boolean {
  const walk: AllocationWalkContext = { eventType: "subscription" };
  return (startsAt, endsAt) => {
    for (
      let t = startsAt.getTime();
      t < endsAt.getTime();
      t += SCHEDULING_INTERVAL_MS
    ) {
      if (!isWithinAvailability(new Date(t), consultant, walk)) return false;
    }
    return true;
  };
}
