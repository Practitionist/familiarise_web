import { MANUAL_ONLY } from "@/lib/cron/manual-only";
import { OPERATIONAL_COMPLETION_REQUIREMENTS } from "@/lib/cron/operational-health";
import { jobNameFor, TARGETS, type Target } from "@/lib/cron/schedule";

/** Pure inputs only: this check runs inside `npm run build`, with no env, database or network. */
interface JobCoverageInput {
  /** `@cleanup-twin` slugs of `lib/cron/cleanup-registry.ts`, from {@link registrySlugs}. */
  registrySlugs: readonly string[];
  targets?: readonly string[];
  manualOnly?: Readonly<Record<string, string>>;
  requirements?: readonly { target: string; jobName: string; tier: string }[];
  jobNameOf?: (target: string) => string;
}

const TIERS: ReadonlySet<string> = new Set(["paging", "watched"]);
const LIVE_TARGETS: ReadonlySet<string> = new Set(TARGETS);

function isLiveTarget(name: string): name is Target {
  return LIVE_TARGETS.has(name);
}

function liveJobNameOf(target: string): string {
  return isLiveTarget(target) ? jobNameFor(target) : target;
}

/** The registry's slugs, read as text so no job module (and no Prisma or Redis) loads. */
export function registrySlugs(registrySource: string): string[] {
  return Array.from(
    registrySource.matchAll(/\/\/\s*@cleanup-twin\s+([a-z0-9-]+)\s*$/gm),
    (match) => match[1],
  );
}

/**
 * Every registry job is scheduled or explicitly manual, and every ticker target
 * has exactly one freshness requirement under its live run-row name. Returns the violations.
 */
export function checkJobCoverage(input: JobCoverageInput): string[] {
  const {
    registrySlugs: slugs,
    targets = TARGETS,
    manualOnly = MANUAL_ONLY,
    requirements = OPERATIONAL_COMPLETION_REQUIREMENTS,
    jobNameOf = liveJobNameOf,
  } = input;
  const violations: string[] = [];
  if (slugs.length === 0) {
    violations.push(
      "lib/cron/cleanup-registry.ts: no `// @cleanup-twin <slug>` markers found; the registry or its parser changed.",
    );
  }
  const slugSet = new Set(slugs);
  const targetSet = new Set(targets);
  for (const slug of slugs) {
    if (!targetSet.has(slug) && !(slug in manualOnly)) {
      violations.push(
        `Registry job "${slug}" has no ticker target in TARGETS (lib/cron/schedule.ts) and no MANUAL_ONLY reason (lib/cron/manual-only.ts).`,
      );
    }
  }
  for (const slug of Object.keys(manualOnly)) {
    if (!slugSet.has(slug)) {
      violations.push(`MANUAL_ONLY entry "${slug}" names no registry job.`);
    }
    if (targetSet.has(slug)) {
      violations.push(
        `MANUAL_ONLY entry "${slug}" is also a ticker target; remove one.`,
      );
    }
  }
  const liveNames = new Set(targets.map(jobNameOf));
  for (const target of targets) {
    const own = requirements.filter((r) => r.target === target);
    if (own.length !== 1) {
      violations.push(
        `Ticker target "${target}" has ${own.length} freshness requirements (lib/cron/operational-health.ts); it needs exactly one.`,
      );
    }
  }
  const watchers = new Map<string, number>();
  for (const requirement of requirements) {
    const { target, jobName, tier } = requirement;
    watchers.set(jobName, (watchers.get(jobName) ?? 0) + 1);
    if (!targetSet.has(target)) {
      violations.push(
        `Freshness requirement names "${target}", which is not a ticker target.`,
      );
    } else if (jobName !== jobNameOf(target)) {
      violations.push(
        `Freshness requirement for "${target}" watches "${jobName}", but the target writes run rows as "${jobNameOf(target)}" (JOB_NAME_OVERRIDES in lib/cron/schedule.ts).`,
      );
    }
    if (!liveNames.has(jobName)) {
      violations.push(
        `Freshness requirement watches "${jobName}", which no ticker target writes.`,
      );
    }
    if (!TIERS.has(tier)) {
      violations.push(
        `Freshness requirement for "${target}" has tier "${tier}"; it must be paging or watched.`,
      );
    }
  }
  for (const [jobName, count] of watchers) {
    if (count > 1) {
      violations.push(`${count} freshness requirements watch "${jobName}".`);
    }
  }
  return violations;
}
