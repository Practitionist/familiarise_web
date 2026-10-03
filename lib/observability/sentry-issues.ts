/**
 * Read Sentry issues for one user, for the back-office triage surfaces.
 *
 * ## Why this exists
 *
 * The platform has a full support system (tickets, per-appointment threads,
 * CSAT, `PLATFORM_TECHNICAL` escalation) and a full Sentry project, and until
 * this module they had no join between them. A support agent reading
 * "payment page 500s" could not answer "which of my users is affected", and an
 * engineer reading a Sentry issue could not answer "who is waiting on me".
 * `user.id` is a first-class indexed Sentry field — the same one behind the
 * "Users affected" count and `sort=user` — so the join is one indexed query,
 * not a scrape.
 *
 * ## Token
 *
 * Needs a Sentry auth token with the `event:read` scope:
 *   https://sentry.io/settings/account/api/auth-tokens/
 *
 * Read `SENTRY_API_TOKEN`. Deliberately NOT `SENTRY_AUTH_TOKEN` — that one is
 * the build-time source-map uploader, it carries `project:releases` rather than
 * `event:read`, it is present in a different set of environments (the Netlify
 * build, not the running app), and the local copy is reported dead (401). Two
 * differently-scoped tokens with confusingly similar names is a trap; this one
 * is new and app-only.
 *
 * ## Degradation
 *
 * Every failure path returns `{ configured: false, issues: null }` rather than
 * throwing. A triage panel is an enrichment, not a gate: if Sentry is down, or
 * the token is missing, or the rate limit bites, the back-office must still
 * render the person's bookings and payments. It is never on a write path.
 */

import "server-only";

import { resolveSentryUserId } from "./identity";
import type {
  SentryIssueSummary,
  UserSentryIssues,
} from "./sentry-issues-types";

/**
 * Sentry endpoints, from the environment with a default.
 *
 * These were hard-coded on the argument that two env vars can drift apart
 * where two constants cannot. That is the wrong trade: the org slug and the
 * region are deployment-specific, not project-specific. A self-hosted Sentry,
 * an EU region, or a second org in a different workspace all break a
 * compiled-in constant and none of them break an env var. The drift the
 * concern was really about is handled by the defaults below staying in step
 * with `next.config.mjs`, and by the fact that a wrong default fails loudly
 * (401/404) rather than silently.
 */
const SENTRY_API_BASE = process.env.SENTRY_API_URL || "https://us.sentry.io";
// `SENTRY_ORG` / `SENTRY_PROJECT` are the names the build already uses for
// withSentryConfig, so reusing them here means pointing the app at a different
// workspace is one env change rather than two that can disagree.
const SENTRY_ORG_SLUG = process.env.SENTRY_ORG || "practitionist";
const SENTRY_PROJECT_SLUG = process.env.SENTRY_PROJECT || "familiarise_web";
const SENTRY_WEB_BASE =
  process.env.SENTRY_WEB_URL || "https://practitionist.sentry.io";

/**
 * Sentry rate-limits per plan and returns 429 with `Retry-After`. A back-office
 * page that fires several of these in a render must not hold a request open
 * waiting on a quota it does not control, so the budget is short and hard.
 */
const REQUEST_TIMEOUT_MS = 2_500;

const DEFAULT_LIMIT = 8;
const DEFAULT_STATS_PERIOD = "14d";

function isConfigured(): boolean {
  return Boolean(process.env.SENTRY_API_TOKEN);
}

/**
 * Build the issue-search query.
 *
 * `user.id:` is the indexed user field written by `lib/observability/identity`.
 * Passes `userId` through `resolveSentryUserId` so when `SENTRY_IDENTITY_SALT`
 * is set, the back-office query looks up the exact HMAC virtual token (`ust_…`)
 * that `setSentryIdentity` stamped on outgoing events.
 */
function buildQuery(userId: string): string {
  return `user.id:"${resolveSentryUserId(userId)}" is:unresolved`;
}

export async function findUserIssues(opts: {
  userId: string;
  limit?: number;
  statsPeriod?: string;
}): Promise<UserSentryIssues> {
  if (!isConfigured()) return { configured: false, issues: null };

  const { userId } = opts;
  if (!userId) return { configured: false, issues: null };

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 25);
  const statsPeriod = opts.statsPeriod ?? DEFAULT_STATS_PERIOD;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // INSIDE the try on purpose. `new URL` throws on a malformed base — a
    // `SENTRY_API_URL` with no scheme, or one carrying a stray path — and a
    // throw here used to reject `findUserIssues` outright, which rejected
    // `readUser360` and could take the support page down with it. This module
    // promises every failure path resolves to `{configured:false}`, and a
    // misconfigured base is a failure path, not a programming error.
    const url = new URL(
      `${SENTRY_API_BASE}/api/0/organizations/${SENTRY_ORG_SLUG}/issues/`,
    );
    url.searchParams.set("query", buildQuery(userId));
    url.searchParams.set("project", SENTRY_PROJECT_SLUG);
    url.searchParams.set("statsPeriod", statsPeriod);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "date");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SENTRY_API_TOKEN}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      // 401/403 = token wrong or under-scoped; 429 = quota. Both are
      // operational facts for whoever owns the token, but neither should
      // surface on a support agent's screen mid-incident, so they are logged
      // and swallowed.
      // No userId: this line goes to the platform log, and a cuid is the same
      // pseudonym the rest of this branch is careful about. The status is what
      // identifies the failure; the subject is the lookup's own argument and is
      // not needed to act on it.
      console.warn(
        `[sentry-issues] ${res.status} from Sentry; triage panel will be empty`,
      );
      return { configured: false, issues: null };
    }

    const payload: unknown = await res.json();
    if (!Array.isArray(payload)) {
      return { configured: false, issues: null };
    }

    const issues = payload
      .map(toSummary)
      .filter((i): i is SentryIssueSummary => i !== null)
      .slice(0, limit);

    return { configured: true, issues };
  } catch (err) {
    // Abort, DNS, malformed JSON — none of which should fail a page render.
    console.warn(
      "[sentry-issues] lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { configured: false, issues: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reduce a Sentry issue to what a support agent can act on. Deliberately
 * drops the stack, the tags and the `extra` blob: this is a triage list, and
 * the agent clicks through to the issue for detail.
 */
function toSummary(raw: unknown): SentryIssueSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const shortId = typeof r.shortId === "string" ? r.shortId : null;
  const title = typeof r.title === "string" ? r.title : null;
  if (!shortId || !title) return null;
  const culprit = typeof r.culprit === "string" ? r.culprit : null;
  const level = typeof r.level === "string" ? r.level : null;
  const lastSeen = typeof r.lastSeen === "string" ? r.lastSeen : null;
  // Prefer the permalink Sentry hands back: it already knows the region and the
  // web base for this org, which a URL rebuilt from `id` only gets right by
  // coincidence. Fall back to the constructed form for an older payload shape.
  const permalink =
    typeof r.permalink === "string" && r.permalink.length > 0
      ? r.permalink
      : `${SENTRY_WEB_BASE}/issues/${typeof r.id === "string" ? r.id : shortId}/`;

  return {
    shortId,
    title,
    ...(culprit ? { culprit } : {}),
    ...(level ? { level } : {}),
    ...(lastSeen ? { lastSeen } : {}),
    permalink,
  };
}
