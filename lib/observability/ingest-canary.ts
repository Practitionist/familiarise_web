import { z } from "zod";

/**
 * Sentry ingest canary: reads the organisation's error outcomes for the last
 * day from `stats_v2` instead of posting a probe event, so it spends no error
 * quota. A quota or rate-limit rejection, or an unreadable stats answer, is
 * unhealthy.
 */

const STATS_PERIOD = "1d";
const FETCH_TIMEOUT_MS = 8_000;
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  "usage_exceeded",
  "error_usage_exceeded",
]);

const statsResponseSchema = z.object({
  groups: z.array(
    z.object({
      by: z.object({
        outcome: z.string(),
        reason: z.string().optional(),
      }),
      totals: z.object({ "sum(quantity)": z.number().nonnegative() }),
    }),
  ),
});

export type IngestVerdict = "accepted" | "rejecting" | "stats-unreadable";

export interface IngestRejection {
  outcome: string;
  reason: string;
  count: number;
}

export interface IngestCheck {
  verdict: IngestVerdict;
  /** Errors Sentry stored over the period. */
  accepted: number;
  /** Quota or rate-limit rejections over the period, by outcome and reason. */
  rejections: IngestRejection[];
  /** Why the stats could not be read; null when they were. */
  detail: string | null;
}

export function sentryStatsUrl(): string {
  const base = (process.env.SENTRY_API_URL || "https://us.sentry.io").replace(
    /\/+$/,
    "",
  );
  const org = process.env.SENTRY_ORG || "practitionist";
  const qs = new URLSearchParams({
    category: "error",
    field: "sum(quantity)",
    statsPeriod: STATS_PERIOD,
  });
  qs.append("groupBy", "outcome");
  qs.append("groupBy", "reason");
  return `${base}/api/0/organizations/${encodeURIComponent(org)}/stats_v2/?${qs.toString()}`;
}

function isRejection(outcome: string, reason: string | undefined): boolean {
  return outcome === "rate_limited" || QUOTA_REASONS.has(reason ?? "");
}

/** Judges one `stats_v2` body grouped by outcome and reason. */
export function judgeStats(body: unknown): IngestCheck {
  const parsed = statsResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      verdict: "stats-unreadable",
      accepted: 0,
      rejections: [],
      detail: "stats_v2 answered an unexpected shape",
    };
  }
  let accepted = 0;
  const rejections: IngestRejection[] = [];
  for (const group of parsed.data.groups) {
    const count = group.totals["sum(quantity)"];
    if (group.by.outcome === "accepted") accepted += count;
    else if (count > 0 && isRejection(group.by.outcome, group.by.reason)) {
      rejections.push({
        outcome: group.by.outcome,
        reason: group.by.reason ?? "none",
        count,
      });
    }
  }
  return {
    verdict: rejections.length > 0 ? "rejecting" : "accepted",
    accepted,
    rejections,
    detail: null,
  };
}

/** Never throws; a failed read is the `stats-unreadable` verdict. */
export async function checkSentryIngest(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestCheck> {
  try {
    const res = await fetchImpl(sentryStatsUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        verdict: "stats-unreadable",
        accepted: 0,
        rejections: [],
        detail: `stats_v2 answered ${res.status}`,
      };
    }
    return judgeStats(await res.json());
  } catch (err) {
    return {
      verdict: "stats-unreadable",
      accepted: 0,
      rejections: [],
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isIngestHealthy(r: IngestCheck): boolean {
  return r.verdict === "accepted";
}

/** One operator-readable line, usable as an email summary or a log message. */
export function describeIngest(r: IngestCheck): string {
  if (r.verdict === "accepted") {
    return `Sentry accepted ${r.accepted} error(s) in the last day and rejected none.`;
  }
  if (r.verdict === "stats-unreadable") {
    return `The Sentry stats read failed, so ingest health is unknown: ${r.detail ?? "no detail"}.`;
  }
  const rejected = r.rejections.reduce((n, x) => n + x.count, 0);
  const reasons = r.rejections
    .map((x) => `${x.count} ${x.outcome}/${x.reason}`)
    .join(", ");
  return `Sentry REJECTED ${rejected} error(s) in the last day (${reasons}) and accepted ${r.accepted}.`;
}

/** The spent-allowance case, as distinct from a short-window throttle. */
export function isQuotaExhausted(r: IngestCheck): boolean {
  return r.rejections.some((x) => QUOTA_REASONS.has(x.reason));
}
