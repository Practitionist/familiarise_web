import { z } from "zod";

const REPOSITORY = "Practitionist/familiarise_web";
const RELEASE_SOURCE_BRANCH = "dev";
const GITHUB_API = "https://api.github.com";
const HTTP_TIMEOUT_MS = 4_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** An unreleased schedule or registry change pages after this. */
const SCHEDULE_LAG_MS = 3 * DAY_MS;
/** Any unreleased merge pages after this. */
const ANY_LAG_MS = 7 * DAY_MS;
/** A change here alters what the ticker runs, so it has the shorter limit. */
const SCHEDULE_FILES = ["lib/cron/schedule.ts", "lib/cron/cleanup-registry.ts"];
const WATCHED_AREAS: readonly {
  label: string;
  matches: (file: string) => boolean;
}[] = [
  ...SCHEDULE_FILES.map((path) => ({
    label: path,
    matches: (file: string) => file === path,
  })),
  {
    label: "netlify/functions/**",
    matches: (file) => file.startsWith("netlify/functions/"),
  },
  { label: "prisma/**", matches: (file) => file.startsWith("prisma/") },
];
/** The compare API lists at most 300 files for the whole comparison. */
const COMPARE_FILE_LIMIT = 300;

const count = z.number().int().nonnegative();

export const releaseLagSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    buildSha: z.string(),
    commitsBehind: count,
    oldestUnreleasedAt: z.string().datetime().nullable(),
    scheduleChangeAt: z.string().datetime().nullable(),
    /** Watched areas an unreleased commit touches; all of them when the file list was truncated. */
    touches: z.array(z.string()),
    truncated: z.boolean(),
    overdue: z.boolean(),
  }),
  z.object({
    status: z.literal("unknown"),
    reason: z.string(),
    overdue: z.literal(false),
  }),
]);
export type ReleaseLag = z.infer<typeof releaseLagSchema>;

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    committer: z.object({ date: z.string().datetime() }).nullable(),
  }),
});
const compareSchema = z.object({
  ahead_by: count,
  commits: z.array(commitSchema),
  files: z.array(z.object({ filename: z.string() })).optional(),
});

export function unknownReleaseLag(reason: string): ReleaseLag {
  return { status: "unknown", reason, overdue: false };
}

/**
 * Overdue when an unreleased schedule or registry change is older than 3 days,
 * any unreleased commit is older than 7, or the commit list was cut short.
 */
export function releaseLagVerdict(input: {
  buildSha: string;
  commitsBehind: number;
  /** Commits the compare API listed; fewer than `commitsBehind` means it cut the list. */
  commitsListed: number;
  commitDates: readonly Date[];
  files: readonly string[];
  scheduleChangeAt: Date | null;
  now: Date;
}): ReleaseLag {
  const { commitDates, files, now } = input;
  const oldest =
    commitDates.length > 0
      ? new Date(Math.min(...commitDates.map((d) => d.getTime())))
      : null;
  const commitsTruncated = input.commitsListed < input.commitsBehind;
  const filesTruncated = files.length >= COMPARE_FILE_LIMIT;
  const age = (at: Date | null) => (at ? now.getTime() - at.getTime() : 0);
  return {
    status: "known",
    buildSha: input.buildSha,
    commitsBehind: input.commitsBehind,
    oldestUnreleasedAt: oldest?.toISOString() ?? null,
    scheduleChangeAt: input.scheduleChangeAt?.toISOString() ?? null,
    touches: WATCHED_AREAS.filter(
      (area) => filesTruncated || files.some(area.matches),
    ).map((area) => area.label),
    truncated: commitsTruncated || filesTruncated,
    overdue:
      commitsTruncated ||
      age(input.scheduleChangeAt) > SCHEDULE_LAG_MS ||
      age(oldest) > ANY_LAG_MS,
  };
}

async function github(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}/repos/${REPOSITORY}/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "familiarise-ops-digest",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

const committedAt = (c: z.infer<typeof commitSchema>) =>
  c.commit.committer ? new Date(c.commit.committer.date) : null;

/**
 * The oldest unreleased commit that touches the schedule or the registry, read
 * per file because the compare API's file list is not per commit. A failed read
 * falls back to the oldest unreleased commit, so it can page early but never late.
 */
async function oldestScheduleChange(
  token: string,
  unreleased: ReadonlyMap<string, Date | null>,
  fallback: Date | null,
): Promise<Date | null> {
  try {
    const lists = await Promise.all(
      SCHEDULE_FILES.map(async (file) =>
        z
          .array(commitSchema)
          .parse(
            await github(
              `commits?sha=${RELEASE_SOURCE_BRANCH}&path=${encodeURIComponent(file)}&per_page=100`,
              token,
            ),
          ),
      ),
    );
    const dates = lists
      .flat()
      .filter((c) => unreleased.has(c.sha))
      .map(committedAt)
      .filter((at): at is Date => at !== null);
    return dates.length > 0
      ? new Date(Math.min(...dates.map((d) => d.getTime())))
      : null;
  } catch {
    return fallback;
  }
}

/** How far the deployed build trails `dev`, from GitHub's compare API; never throws. */
export async function readReleaseLag(now: Date): Promise<ReleaseLag> {
  const buildSha = process.env.BUILD_SHA?.trim();
  if (!buildSha) return unknownReleaseLag("BUILD_SHA not set on this build");
  const token = process.env.GITHUB_RELEASE_LAG_TOKEN?.trim();
  if (!token)
    return unknownReleaseLag("GITHUB_RELEASE_LAG_TOKEN not configured");
  try {
    const compare = compareSchema.parse(
      await github(
        `compare/${encodeURIComponent(buildSha)}...${RELEASE_SOURCE_BRANCH}`,
        token,
      ),
    );
    const unreleased = new Map(
      compare.commits.map((c) => [c.sha, committedAt(c)]),
    );
    const commitDates = [...unreleased.values()].filter(
      (at): at is Date => at !== null,
    );
    const files = (compare.files ?? []).map((f) => f.filename);
    const oldest =
      commitDates.length > 0
        ? new Date(Math.min(...commitDates.map((d) => d.getTime())))
        : null;
    const touchesSchedule =
      files.length >= COMPARE_FILE_LIMIT ||
      files.some((file) => SCHEDULE_FILES.includes(file));
    return releaseLagVerdict({
      buildSha,
      commitsBehind: compare.ahead_by,
      commitsListed: compare.commits.length,
      commitDates,
      files,
      scheduleChangeAt: touchesSchedule
        ? await oldestScheduleChange(token, unreleased, oldest)
        : null,
      now,
    });
  } catch (error) {
    return unknownReleaseLag(failureReason(error));
  }
}

function failureReason(error: unknown): string {
  if (error instanceof z.ZodError) return "unexpected GitHub response shape";
  return error instanceof Error ? error.message : "GitHub read failed";
}
