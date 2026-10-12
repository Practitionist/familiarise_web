/** The platform recording retention schedule; client-safe so settings copy cannot drift from the sweep. */
export const RECORDING_RETENTION_SCHEDULE = {
  /** 1:1 consultations, after the session. */
  oneToOneDays: 90,
  /** Subscriptions and trials, after the subscription ends. */
  subscriptionDays: 90,
  /** Webinars after the session; classes after the final session. */
  groupDays: 365,
} as const;
