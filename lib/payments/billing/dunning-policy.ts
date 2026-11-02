/** The dunning cadence, shared by the job and the overdue-notice gauge and inbox. */
export const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REMINDERS = 3;

/** Only reachable organisations are dunned; DEACTIVATED ones are torn down. */
export const DUNNABLE_ORG_STATUSES = [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
] as const;
