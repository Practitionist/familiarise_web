/** Client-safe: the console's job categories and card shape, with no registry import. */
export const JOB_CATEGORIES = [
  "Payments",
  "Refunds",
  "Disputes",
  "Earnings",
  "Payouts",
  "Billing",
  "Compliance",
  "Appointments",
  "Messaging",
  "Recordings",
  "Support",
  "Reconciliation",
  "Alerts",
  "Cleanup",
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

/** One registry job as the System Jobs panel renders it; built on the server. */
export interface SystemJobCard {
  /** The registry slug, which is what the Run door accepts. */
  id: string;
  title: string;
  description: string;
  category: JobCategory;
  /** The schedule window in IST, as operators read every time. */
  schedule: string;
  /** The same window in UTC, the zone the schedule catalog defines it in. */
  scheduleUtc: string;
  /** The typed phrase a manual run asks for, or null when a reason is enough. */
  confirmPhrase: string | null;
  /** Why Run is disabled right now, or null when it is available. */
  runBlocked: string | null;
}
