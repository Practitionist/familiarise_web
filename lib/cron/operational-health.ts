const MINUTE_MS = 60_000;

// Completion SLOs, not scheduling instructions. Optional and calendar-only jobs need separate checks.
export const OPERATIONAL_COMPLETION_REQUIREMENTS = [
  { jobName: "reconcile-payment-status", maxAgeMinutes: 45 },
  { jobName: "reconcile-pending-refunds", maxAgeMinutes: 45 },
  { jobName: "retry-auto-refunds", maxAgeMinutes: 45 },
  { jobName: "sweep-stuck-webhook-events", maxAgeMinutes: 45 },
  { jobName: "retry-failed-emails", maxAgeMinutes: 45 },
  { jobName: "drain-notification-outbox", maxAgeMinutes: 45 },
  { jobName: "send-appointment-reminders", maxAgeMinutes: 45 },
  { jobName: "auto-complete-appointments", maxAgeMinutes: 90 },
  { jobName: "detect-consultant-no-shows", maxAgeMinutes: 90 },
  { jobName: "support-sla-sweep", maxAgeMinutes: 60 },
  { jobName: "transfer-recordings", maxAgeMinutes: 45 },
  { jobName: "reconcile-orphaned-sessions", maxAgeMinutes: 90 },
  { jobName: "expire-recordings", maxAgeMinutes: 27 * 60 },
  { jobName: "reconcile-orphaned-recordings", maxAgeMinutes: 27 * 60 },
  { jobName: "wind-down-deactivated-orgs", maxAgeMinutes: 27 * 60 },
  { jobName: "stream-sync", maxAgeMinutes: 27 * 60 },
  { jobName: "expire-event-channels", maxAgeMinutes: 27 * 60 },
] as const;

export interface JobCompletion {
  jobName: string;
  endedAt: Date | null;
}

export function assessOperationalCompletions(
  completions: readonly JobCompletion[],
  now = new Date(),
) {
  const latest = new Map<string, Date>();
  for (const row of completions) {
    const endedAt = row.endedAt;
    if (endedAt && endedAt > (latest.get(row.jobName) ?? new Date(0))) {
      latest.set(row.jobName, endedAt);
    }
  }
  const jobs = OPERATIONAL_COMPLETION_REQUIREMENTS.map((requirement) => {
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
  return { healthy: jobs.every((job) => !job.overdue), jobs };
}
