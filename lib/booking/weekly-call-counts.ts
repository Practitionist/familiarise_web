import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

/**
 * #997 Phase 3 — confirmed calls per week. #1554 — one live, non-tentative
 * occurrence row on the subscription's wrapper is one call; each is bucketed
 * on its own by the SAME scheduling-timezone week key (ADR B9) the server
 * validator uses, so the interactive weekly-limit guard can do an O(1) lookup
 * instead of re-deriving this from a whole-window fetch on every slot click.
 * A tentative row is the old call mid-reschedule and a dead row never
 * happened; neither counts, and neither hides its siblings.
 */
export function computeWeeklyConfirmedCallCounts(
  appointments: Array<{
    appointmentType: string;
    subscription?: { id?: string; schedulingTimezone?: string | null } | null;
    occurrences?: Array<{
      startsAt: Date | string;
      isTentative?: boolean;
      completionStatus?: string | null;
      deletedAt?: Date | string | null;
    }>;
  }>,
  subscriptionId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const appt of appointments) {
    if (appt.appointmentType !== "SUBSCRIPTION") continue;
    if (appt.subscription?.id !== subscriptionId) continue;
    for (const row of appt.occurrences ?? []) {
      if (row.isTentative || row.deletedAt) continue;
      if (
        row.completionStatus === "CANCELLED" ||
        row.completionStatus === "RESCHEDULED"
      )
        continue;
      if (!row.startsAt) continue;
      const weekKey = ScheduleCalculationService.weekKey(
        new Date(row.startsAt),
        appt.subscription?.schedulingTimezone || undefined,
      );
      counts[weekKey] = (counts[weekKey] || 0) + 1;
    }
  }
  return counts;
}
