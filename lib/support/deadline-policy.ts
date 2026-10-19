const HOUR = 3_600_000;

const DEADLINE_HOURS = {
  GENERAL: 7 * 24,
  GRIEVANCE: 7 * 24,
  CONTENT_REMOVAL: 36,
  INTIMATE_CONTENT: 2,
  LEGAL_TAKEDOWN: 3,
} as const;

export function supportDeadline(category: string | null | undefined, receivedAt: Date) {
  const key = category && Object.hasOwn(DEADLINE_HOURS, category) ? category : "GENERAL";
  const hours = Object.entries(DEADLINE_HOURS).find(([name]) => name === key)?.[1] ?? DEADLINE_HOURS.GENERAL;
  return {
    deadlinePolicy: `IN-2026-02:${key}`,
    statutoryDueAt: new Date(receivedAt.getTime() + hours * HOUR),
  };
}
