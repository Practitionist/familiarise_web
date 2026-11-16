const HOUR = 3_600_000;

export const DEADLINE_HOURS = {
  GENERAL: 7 * 24,
  GRIEVANCE: 7 * 24,
  CONTENT_REMOVAL: 36,
  INTIMATE_CONTENT: 2,
  LEGAL_TAKEDOWN: 3,
  CONDUCT_REMOVAL: 72,
} as const;

/** How long after resolution the customer may say "This didn't fix it" on an undecided case. */
export const REOPEN_WINDOW_MS = 14 * 24 * HOUR;

export function supportDeadline(
  category: string | null | undefined,
  receivedAt: Date,
) {
  const key =
    category && Object.hasOwn(DEADLINE_HOURS, category) ? category : "GENERAL";
  const hours =
    Object.entries(DEADLINE_HOURS).find(([name]) => name === key)?.[1] ??
    DEADLINE_HOURS.GENERAL;
  return {
    deadlinePolicy: `IN-2026-02:${key}`,
    statutoryDueAt: new Date(receivedAt.getTime() + hours * HOUR),
  };
}

export function moderationDeadline(reason: string, receivedAt: Date) {
  const normalized = reason.trim().toUpperCase();
  const category = [
    "INTIMATE_CONTENT",
    "NON_CONSENSUAL_INTIMATE_CONTENT",
    "SEXUAL_CONTENT",
    "IMPERSONATION",
  ].includes(normalized)
    ? "INTIMATE_CONTENT"
    : "CONTENT_REMOVAL";
  const deadline = supportDeadline(category, receivedAt);
  return {
    acknowledgementDueAt: new Date(
      Math.min(
        receivedAt.getTime() + 24 * HOUR,
        deadline.statutoryDueAt.getTime(),
      ),
    ),
    resolutionDueAt: deadline.statutoryDueAt,
    deadlinePolicy: deadline.deadlinePolicy,
  };
}
