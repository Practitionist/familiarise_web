const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * `paging` makes /api/health/jobs answer 503 when overdue; `watched` only turns
 * the console red, until the job has shown clean production days.
 */
export type SloTier = "paging" | "watched";

export interface CompletionRequirement {
  jobName: string;
  maxAgeMinutes: number;
  tier: SloTier;
}

// Completion SLOs, not scheduling instructions. A partial run counts as having run to the end.
// Watched ages are about two ticker intervals plus 30 minutes; a calendar window gets its period plus slack.
export const OPERATIONAL_COMPLETION_REQUIREMENTS: readonly CompletionRequirement[] =
  [
    { jobName: "reconcile-payment-status", maxAgeMinutes: 45, tier: "paging" },
    {
      jobName: "reconcile-org-invoice-payments",
      maxAgeMinutes: 12 * 60,
      tier: "paging",
    },
    { jobName: "reconcile-pending-refunds", maxAgeMinutes: 45, tier: "paging" },
    { jobName: "retry-auto-refunds", maxAgeMinutes: 45, tier: "paging" },
    {
      jobName: "sweep-stuck-webhook-events",
      maxAgeMinutes: 45,
      tier: "paging",
    },
    { jobName: "retry-failed-emails", maxAgeMinutes: 45, tier: "paging" },
    { jobName: "drain-notification-outbox", maxAgeMinutes: 45, tier: "paging" },
    {
      jobName: "send-appointment-reminders",
      maxAgeMinutes: 45,
      tier: "paging",
    },
    { jobName: "process-data-exports", maxAgeMinutes: 45, tier: "paging" },
    { jobName: "expire-stale-requests", maxAgeMinutes: 45, tier: "paging" },
    {
      jobName: "auto-complete-appointments",
      maxAgeMinutes: 90,
      tier: "paging",
    },
    {
      jobName: "detect-consultant-no-shows",
      maxAgeMinutes: 90,
      tier: "paging",
    },
    { jobName: "support-sla-sweep", maxAgeMinutes: 60, tier: "paging" },
    { jobName: "transfer-recordings", maxAgeMinutes: 45, tier: "paging" },
    {
      jobName: "reconcile-orphaned-sessions",
      maxAgeMinutes: 90,
      tier: "paging",
    },
    { jobName: "expire-recordings", maxAgeMinutes: 27 * 60, tier: "paging" },
    {
      jobName: "reconcile-orphaned-recordings",
      maxAgeMinutes: 27 * 60,
      tier: "paging",
    },
    {
      jobName: "wind-down-deactivated-orgs",
      maxAgeMinutes: 27 * 60,
      tier: "paging",
    },
    { jobName: "stream-sync", maxAgeMinutes: 27 * 60, tier: "paging" },
    {
      jobName: "expire-event-channels",
      maxAgeMinutes: 27 * 60,
      tier: "paging",
    },
    // Hourly ticker targets.
    { jobName: "process-payouts", maxAgeMinutes: 150, tier: "watched" },
    { jobName: "reconcile-disputes", maxAgeMinutes: 150, tier: "watched" },
    { jobName: "reconcile-ledgers", maxAgeMinutes: 150, tier: "watched" },
    {
      jobName: "settle-platform-incidents",
      maxAgeMinutes: 150,
      tier: "watched",
    },
    // Two-hourly, half-hourly and six-hourly ticker targets.
    { jobName: "handle-stuck-payouts", maxAgeMinutes: 270, tier: "watched" },
    { jobName: "reconcile-payout-status", maxAgeMinutes: 270, tier: "watched" },
    {
      jobName: "settle-cancelled-sessions",
      maxAgeMinutes: 90,
      tier: "watched",
    },
    { jobName: "vest-referral-credits", maxAgeMinutes: 90, tier: "watched" },
    { jobName: "heal-consumer-invoices", maxAgeMinutes: 750, tier: "watched" },
    // Daily calendar windows.
    {
      jobName: "reconcile-gateway-settlements",
      maxAgeMinutes: 27 * 60,
      tier: "watched",
    },
    {
      jobName: "generate-subscription-invoices",
      maxAgeMinutes: 27 * 60,
      tier: "watched",
    },
    { jobName: "dunning", maxAgeMinutes: 27 * 60, tier: "watched" },
    { jobName: "irp-uploader", maxAgeMinutes: 27 * 60, tier: "watched" },
    // The Monday window and the first-of-month windows.
    {
      jobName: "create-payout-batch",
      maxAgeMinutes: 7 * DAY_MINUTES + 4 * 60,
      tier: "watched",
    },
    {
      jobName: "settle-invoice-accruals",
      maxAgeMinutes: 32 * DAY_MINUTES,
      tier: "watched",
    },
    {
      jobName: "expire-referral-credits",
      maxAgeMinutes: 32 * DAY_MINUTES,
      tier: "watched",
    },
  ];

export interface JobCompletion {
  jobName: string;
  endedAt: Date | null;
}

/** Only paging requirements decide `healthy`; pass `tier` to report one tier alone. */
export function assessOperationalCompletions(
  completions: readonly JobCompletion[],
  now = new Date(),
  tier?: SloTier,
) {
  const latest = new Map<string, Date>();
  for (const row of completions) {
    const endedAt = row.endedAt;
    if (endedAt && endedAt > (latest.get(row.jobName) ?? new Date(0))) {
      latest.set(row.jobName, endedAt);
    }
  }
  const jobs = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
    (requirement) => tier === undefined || requirement.tier === tier,
  ).map((requirement) => {
    const endedAt = latest.get(requirement.jobName);
    return {
      ...requirement,
      lastCompletedAt: endedAt?.toISOString() ?? null,
      overdue:
        !endedAt ||
        now.getTime() - endedAt.getTime() >
          requirement.maxAgeMinutes * MINUTE_MS,
    };
  });
  return {
    healthy: jobs.every((job) => job.tier !== "paging" || !job.overdue),
    jobs,
  };
}
