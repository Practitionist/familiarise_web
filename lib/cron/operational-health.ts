import {
  jobNameFor,
  maxSlotGapMinutes,
  TARGETS,
  type Target,
} from "@/lib/cron/schedule";

const MINUTE_MS = 60_000;
/** One missed slot is tolerated, but never more than six hours of one. */
const MISSED_SLOT_CAP_MINUTES = 6 * 60;
/** Covers a late tick, a background completion and the run's own duration. */
const FRESHNESS_FLOOR_MINUTES = 30;

/**
 * `paging` makes /api/health/jobs answer 503 when overdue; `watched` only turns
 * the System Jobs console red.
 */
export type SloTier = "paging" | "watched";

/**
 * Housekeeping, where a late run only delays cleanup, and the Novu probe, where it only delays a
 * review row. Every other target is money, compliance or user-facing and pages.
 */
const WATCHED_TARGETS: ReadonlySet<Target> = new Set<Target>([
  "novu-step-failure-probe",
  "prune-system-job-executions",
  "prune-system-events",
  "prune-audit-logs",
  "archive-webhook-events",
  "expire-onboarding-drafts",
  "expire-stale-collaborator-invites",
  "purge-unverified-users",
  "sweep-verification",
  "reconcile-document-storage",
  "reconcile-digital-product-storage",
  "drain-admin-run-requests",
]);

export interface CompletionRequirement {
  target: Target;
  jobName: string;
  maxAgeMinutes: number;
  tier: SloTier;
}

/** The target's longest gap between due slots, plus one missed slot (capped) and a floor. */
export function freshnessBudgetMinutes(target: Target): number {
  const gap = maxSlotGapMinutes(target);
  return gap + Math.min(gap, MISSED_SLOT_CAP_MINUTES) + FRESHNESS_FLOOR_MINUTES;
}

/** One requirement per ticker target, under the run-row name its core writes. */
export const OPERATIONAL_COMPLETION_REQUIREMENTS: readonly CompletionRequirement[] =
  TARGETS.map((target) => ({
    target,
    jobName: jobNameFor(target),
    maxAgeMinutes: freshnessBudgetMinutes(target),
    tier: WATCHED_TARGETS.has(target) ? "watched" : "paging",
  }));

export interface JobCompletion {
  jobName: string;
  endedAt: Date | null;
}

function latestByJob(rows: readonly JobCompletion[]): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    const endedAt = row.endedAt;
    if (endedAt && endedAt > (latest.get(row.jobName) ?? new Date(0))) {
      latest.set(row.jobName, endedAt);
    }
  }
  return latest;
}

/**
 * Only paging requirements decide `healthy`; pass `tier` to report one tier alone.
 * A config skip proves the job is scheduled and reached, so it is not overdue.
 */
export function assessOperationalCompletions(args: {
  completions: readonly JobCompletion[];
  configSkips?: readonly JobCompletion[];
  now?: Date;
  tier?: SloTier;
}) {
  const { now = new Date(), tier } = args;
  const completed = latestByJob(args.completions);
  const skipped = latestByJob(args.configSkips ?? []);
  const fresh = (at: Date | undefined, maxAgeMinutes: number) =>
    at !== undefined &&
    now.getTime() - at.getTime() <= maxAgeMinutes * MINUTE_MS;
  const jobs = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
    (requirement) => tier === undefined || requirement.tier === tier,
  ).map((requirement) => {
    const endedAt = completed.get(requirement.jobName);
    const skippedAt = skipped.get(requirement.jobName);
    return {
      ...requirement,
      lastCompletedAt: endedAt?.toISOString() ?? null,
      lastConfigSkipAt: skippedAt?.toISOString() ?? null,
      overdue:
        !fresh(endedAt, requirement.maxAgeMinutes) &&
        !fresh(skippedAt, requirement.maxAgeMinutes),
    };
  });
  return {
    healthy: jobs.every((job) => job.tier !== "paging" || !job.overdue),
    jobs,
  };
}
