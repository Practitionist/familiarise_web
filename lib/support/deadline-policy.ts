const HOUR = 3_600_000;

/**
 * The statutory deadline policies, by category.
 *
 * Every key here must be a category some writer actually produces — an
 * unreachable branch is a deadline the platform believes it is honouring and
 * is not. The two that remain:
 *
 *   GRIEVANCE      — a statutory complaint (the public contact form, the
 *                     DPDP pipeline, a service appeal). Seven days.
 *   CONTENT_REMOVAL — an appeal against a moderation takedown. The DSA and
 *                     the BIS IS 19000 statement-of-reasons duty both make
 *                     this one time-bound: thirty-six hours.
 */
const DEADLINE_HOURS = {
  GRIEVANCE: 7 * 24,
  CONTENT_REMOVAL: 36,
} as const;

type DeadlinePolicy = keyof typeof DEADLINE_HOURS;

const DEFAULT_POLICY: DeadlinePolicy = "GRIEVANCE";

function isDeadlinePolicy(
  category: string | null | undefined,
): category is DeadlinePolicy {
  return (
    typeof category === "string" &&
    Object.prototype.hasOwnProperty.call(DEADLINE_HOURS, category)
  );
}

/**
 * The deadline a case filed under `category` runs to, and the policy that
 * produced it. The policy name is stored on the case so a later change to
 * this table does not retroactively re-date an open case's breach.
 */
export function supportDeadline(
  category: string | null | undefined,
  receivedAt: Date,
): { deadlinePolicy: string; statutoryDueAt: Date } {
  const policy = isDeadlinePolicy(category) ? category : DEFAULT_POLICY;
  return {
    deadlinePolicy: `IN-2026-02:${policy}`,
    statutoryDueAt: new Date(receivedAt.getTime() + DEADLINE_HOURS[policy] * HOUR),
  };
}
