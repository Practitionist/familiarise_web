// A release moves sessions of one plan week at a time: the allocator places a
// released batch into one open week, so a release spanning two weeks could
// never be re-placed. The reschedule route refuses it and the picker defaults
// to the next week's sessions.

import {
  planWeekNumber,
  type SubscriptionEntitlementInput,
} from "@/lib/booking/entitlement";

export type PlanWeekInput = Pick<
  SubscriptionEntitlementInput,
  | "sessionsPerWeek"
  | "durationInMonths"
  | "schedulingPeriodStartsAt"
  | "schedulingTimezone"
>;

/** The refusal's words, shared by the route and the tests. */
export const RELEASE_ONE_WEEK_MESSAGE =
  "Move one week at a time: pick the sessions in a single week.";

/** Whether these session starts fall in more than one plan week. */
export function spansPlanWeeks(
  plan: PlanWeekInput,
  starts: ReadonlyArray<Date | string>,
): boolean {
  const weeks = new Set(
    starts.map((start) => planWeekNumber(plan, new Date(start))),
  );
  return weeks.size > 1;
}

/**
 * The sessions a release should start with: every session when they share a
 * plan week, otherwise the earliest week's sessions only.
 */
export function earliestWeekSessions<T extends { startTime: Date }>(
  plan: PlanWeekInput,
  sessions: readonly T[],
): T[] {
  if (sessions.length === 0) return [];
  const first = Math.min(
    ...sessions.map((s) => planWeekNumber(plan, s.startTime)),
  );
  return sessions.filter((s) => planWeekNumber(plan, s.startTime) === first);
}
