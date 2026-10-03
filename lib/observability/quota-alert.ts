/**
 * Early warning at 70% of the Sentry error quota.
 *
 * The 2026-09-22 outage was found after the quota was spent; the ingest canary
 * only says so once events are already being refused. This reads accepted
 * error counts from the stats API and emails once per billing period when the
 * threshold is crossed, through the canary's own channel (Resend), because
 * reporting a Sentry shortage through Sentry is not a check.
 *
 * Never throws: it runs inside the canary and must not change its verdict.
 */

import { EMAIL_BUDGET_MS, OPS_EMAIL, SENDERS } from "@/lib/email/config";
import { deliver } from "@/lib/email/deliver";
import redis from "@/lib/redis";
import { canaryAlertRecipient } from "./ingest-alert";

export const QUOTA_ALERT_THRESHOLD = 0.7;
const STATE_TTL_MS = 35 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

let loggedNoToken = false;

/** Most recent day-of-month `startDay` (clamped to 1-28), as a UTC midnight. */
export function quotaPeriodStart(now: Date, startDay: number): Date {
  const day = Math.min(28, Math.max(1, Math.trunc(startDay) || 19));
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day);
  return new Date(
    thisMonth <= now.getTime()
      ? thisMonth
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day),
  );
}

export interface QuotaStore {
  get(key: string): Promise<string | null>;
  set(key: string, ttlMs: number): Promise<void>;
}

const redisQuotaStore: QuotaStore = {
  async get(key) {
    return (await redis.get<string>(key)) ?? null;
  },
  async set(key, ttlMs) {
    await redis.set(key, "1", { px: ttlMs });
  },
};

export type QuotaCheckResult =
  | { status: "skipped"; reason: "no-token" | "no-data" }
  | { status: "error"; detail: string }
  | {
      status: "ok";
      accepted: number;
      quota: number;
      ratio: number;
      alerted: boolean;
    };

async function fetchAccepted(token: string, start: Date, end: Date) {
  const base = process.env.SENTRY_API_URL || "https://us.sentry.io";
  const org = process.env.SENTRY_ORG || "practitionist";
  const qs = new URLSearchParams({
    field: "sum(quantity)",
    category: "error",
    outcome: "accepted",
    start: start.toISOString(),
    end: end.toISOString(),
    interval: "1d",
  });
  const res = await fetch(
    `${base}/api/0/organizations/${org}/stats_v2/?${qs.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`stats_v2 answered ${res.status}`);
  const body = (await res.json()) as {
    groups?: Array<{ totals?: Record<string, number> }>;
  };
  const groups = body.groups ?? [];
  if (groups.length === 0) return null;
  return groups.reduce((n, g) => n + (g.totals?.["sum(quantity)"] ?? 0), 0);
}

export async function checkSentryQuota(
  opts: { now?: Date; store?: QuotaStore } = {},
): Promise<QuotaCheckResult> {
  try {
    const token = process.env.SENTRY_STATS_TOKEN;
    if (!token) {
      if (!loggedNoToken) {
        loggedNoToken = true;
        console.log("[sentry-quota] SENTRY_STATS_TOKEN unset, check skipped");
      }
      return { status: "skipped", reason: "no-token" };
    }
    const now = opts.now ?? new Date();
    const store = opts.store ?? redisQuotaStore;
    const start = quotaPeriodStart(
      now,
      Number(process.env.SENTRY_QUOTA_PERIOD_START_DAY ?? 19),
    );
    const quota = Number(process.env.SENTRY_ERROR_QUOTA) || 5000;

    const accepted = await fetchAccepted(token, start, now);
    if (accepted === null) return { status: "skipped", reason: "no-data" };
    const ratio = accepted / quota;
    if (ratio < QUOTA_ALERT_THRESHOLD) {
      return { status: "ok", accepted, quota, ratio, alerted: false };
    }

    // One alert per period and threshold. Unlike the canary's own gate a
    // failed read sends nothing: the check runs every 30 minutes, so failing
    // open would send 48 emails a day while Redis is down. A failed write
    // after a successful send can repeat the alert on a later run.
    const key = `observability:sentry-quota:${start.toISOString().slice(0, 10)}:70`;
    if ((await store.get(key)) !== null) {
      return { status: "ok", accepted, quota, ratio, alerted: false };
    }
    const pct = Math.round(ratio * 100);
    const sent = await deliver(
      {
        from: SENDERS.ops,
        to: canaryAlertRecipient(),
        replyTo: OPS_EMAIL,
        subject: `[Familiarise] Sentry error quota at ${pct}% (${accepted}/${quota}) this period`,
        text: [
          `Sentry has accepted ${accepted} of ${quota} errors since ${start.toISOString().slice(0, 10)}, which is ${pct}% of the free-plan quota.`,
          "",
          "Once the quota is spent Sentry discards every error until the period rolls over, and the dashboard looks quiet, as it did on 2026-09-22.",
          "Triage the top issues by event count now, or upgrade the plan (Team includes 50k errors a month).",
          "This alert is sent once per billing period.",
        ].join("\n"),
        html: `<p>Sentry has accepted <b>${accepted}</b> of <b>${quota}</b> errors since ${start.toISOString().slice(0, 10)} (${pct}% of the free-plan quota).</p><p>Once the quota is spent Sentry discards every error until the period rolls over. Triage the top issues by event count now, or upgrade the plan (Team includes 50k errors a month). This alert is sent once per billing period.</p>`,
      },
      "sentry-quota-alert",
      {
        entityRef: `sentry-quota:${key}`,
        budgetMs: EMAIL_BUDGET_MS.JOB,
      },
    );
    if (sent.success) await store.set(key, STATE_TTL_MS);
    return { status: "ok", accepted, quota, ratio, alerted: sent.success };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[sentry-quota] check failed:", detail);
    return { status: "error", detail };
  }
}
