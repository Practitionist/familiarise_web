/**
 * Email the owner when Sentry stops accepting error events.
 *
 * ## Why email and not Sentry
 *
 * The failure being reported is "Sentry is discarding our errors". Reporting it
 * through Sentry is reporting it through the broken component, which is how
 * this went unnoticed for six days. Email (Resend) is a separate quota, a
 * separate provider and a separate failure mode, which is exactly the property
 * a canary needs.
 *
 * ## Who gets it
 *
 * An env var, not an address compiled in. Defaults to the support mailbox the
 * rest of the app already uses (`lib/email/config.ts:supportEmail()`), so there
 * is no second address to keep in sync and no new recipient to justify.
 *
 * ## Why `deliver()` and not a react-email component
 *
 * Every other sender here renders a `ReactElement` through `send()`. This is an
 * operator alert with a table of ingest-response fields, not a designed email,
 * and a failed render in the canary would take down the canary. Building the
 * `RenderedEmail` directly keeps the one component that must never fail as
 * simple as possible.
 */

import {
  EMAIL_BUDGET_MS,
  OPS_EMAIL,
  SENDERS,
  supportEmail,
} from "@/lib/email/config";
import { deliver } from "@/lib/email/deliver";
import { describeIngest, type IngestProbeResult } from "./ingest-canary";
import { postOpsChat } from "./ops-chat";
import redis from "@/lib/redis";

/**
 * Owner address for observability alerts. Falls back to the platform support
 * mailbox, which is the same default every customer-facing email uses.
 */
export function canaryAlertRecipient(): string {
  return process.env.OBSERVABILITY_ALERT_EMAIL || supportEmail();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rowsFor(r: IngestProbeResult): [string, string][] {
  return [
    ["Verdict", r.verdict],
    ["HTTP status", String(r.status)],
    ["Canary event id", r.eventId],
    ["x-sentry-rate-limits", r.rateLimits ?? "(header absent)"],
    ["Sentry said", r.detail ?? "(no body)"],
  ];
}

/**
 * The remedy is chosen per verdict, because the one thing an operator must
 * never be told is the wrong action. A `rate-limited` alert that said "fix
 * your DSN" would be worse than no alert at all.
 */
function remedyFor(r: IngestProbeResult): string {
  const recheck = [
    "  - Then re-check: POST /api/cleanup/sentry-ingest-canary with the",
    "    CRON_SECRET bearer. A healthy:true body means ingest is back.",
  ];

  if (r.verdict === "unconfigured") {
    return [
      "What this means: no DSN was available in this runtime, so the SDK never",
      "initialised and NOTHING was sent. There is no Sentry incident here —",
      "there is no error reporting at all, which is worse precisely because it",
      "is silent from the start.",
      "",
      "What to do:",
      "  - Set NEXT_PUBLIC_SENTRY_DSN in the runtime environment (Netlify: the",
      "    context the app runs in; the job: the same in GitHub Actions).",
      "  - Confirm sentry.shared.config.ts initialised. It is gated on",
      "    Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN), so a missing value",
      "    disables Sentry silently and by design.",
      "  - Do NOT go looking at whether your DSN is valid: nothing was sent, so",
      "    nothing was rejected.",
      ...recheck,
    ].join("\n");
  }

  if (r.verdict === "rate-limited") {
    return [
      "What this means: the application is reporting errors and they are being",
      "discarded before storage. The Sentry dashboard will look quiet, which is",
      "indistinguishable from 'no errors' unless you know to check.",
      "",
      "What to do:",
      "  - If the rate-limit header names error_usage_exceeded, the organisation's",
      "    error allowance for the billing period is spent. Upgrading the plan",
      "    raises the ceiling immediately (Team includes 50k errors/month against",
      "    Developer's 5k), so this does not have to wait for the period to roll",
      "    over.",
      // Only mention a quota when the header actually does. A short-window
      // throttle clears on its own, and telling someone to upgrade for it
      // spends money on a problem that resolves itself.
      ...(r.rateLimits?.includes("error_usage_exceeded")
        ? []
        : [
            "  - The header does NOT name error_usage_exceeded, so this is a",
            "    short-window throttle rather than a spent allowance. It clears",
            "    on its own; do not buy a plan for it.",
          ]),
      ...recheck,
    ].join("\n");
  }

  // rejected-auth / dropped-despite-2xx / unavailable
  return [
    "What this means: the application is reporting errors and they are not",
    "reaching storage. This is NOT a quota problem — do not upgrade the plan on",
    "the strength of this alert.",
    "",
    "What to do:",
    ...(r.verdict === "rejected-auth"
      ? [
          "  - Sentry saw the DSN and refused it. Confirm NEXT_PUBLIC_SENTRY_DSN",
          "    names the live project and that the public key has not been rotated",
          "    out from under it.",
        ]
      : [
          "  - Read the HTTP status and Sentry's own message in the table above;",
          "    they say which of a bad key, a warm cache dropping the first",
          "    envelope, or Sentry being unwell it is.",
        ]),
    ...recheck,
  ].join("\n");
}

/**
 * Subject and heading, per verdict. `unconfigured` must not say errors are
 * "being discarded" — nothing was sent, so nothing was discarded, and the
 * message would point an operator at a quota that is not the problem.
 */
function headlineFor(r: IngestProbeResult): { subject: string; html: string } {
  if (r.verdict === "unconfigured") {
    return {
      subject: `[Familiarise] Sentry is not configured — no error reporting is happening`,
      html: "Sentry is not configured — nothing is being reported",
    };
  }
  return {
    subject: `[Familiarise] Sentry ingest ${r.verdict} — errors are being discarded`,
    html: "Sentry is not accepting error events",
  };
}

/** Exported for the test to assert on, rather than matching a live send. */
/**
 * Render a remedy string as HTML. Its action lines are markdown-style bullets,
 * so they become list items; the rest become paragraphs. Keeping this derived
 * from `remedyFor` is the point — a separately maintained HTML copy of the
 * remedy is exactly what drifted out of sync with the text body before.
 */
function remedyToHtml(remedy: string): string[] {
  return remedy
    .split("\n\n")
    .filter((para) => para.trim() !== "")
    .map((para) => {
      const bullets = para
        .split("\n")
        .map((line) => (line.startsWith("  - ") ? line.slice(4) : null))
        .filter((line): line is string => line !== null);
      if (bullets.length > 0) {
        return (
          `<ul style="margin:8px 0 0;padding-left:20px">` +
          bullets
            .map((b) => `<li style="margin:4px 0">${escapeHtml(b)}</li>`)
            .join("") +
          `</ul>`
        );
      }
      return `<p style="margin:12px 0 0">${escapeHtml(para.replace(/\n\s*/g, " "))}</p>`;
    });
}

export function buildAlertEmail(r: IngestProbeResult): {
  subject: string;
  text: string;
  html: string;
} {
  const summary = describeIngest(r);
  const rows = rowsFor(r);
  const remedy = remedyFor(r);
  const headline = headlineFor(r);

  const text = [
    headline.html,
    "",
    summary,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    remedy,
  ].join("\n");

  const html = [
    `<h2 style="margin:0 0 12px">${escapeHtml(headline.html)}</h2>`,
    `<p style="margin:0 0 12px">${escapeHtml(summary)}</p>`,
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">`,
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="border:1px solid #ddd"><b>${escapeHtml(k)}</b></td>` +
        `<td style="border:1px solid #ddd"><code>${escapeHtml(v)}</code></td></tr>`,
    ),
    `</table>`,
    // The per-verdict remedy, rendered in full rather than only its first
    // paragraph. This used to be followed by an unconditional billing
    // paragraph, which told an operator to upgrade the plan when the real
    // cause was a missing DSN or a rejected auth token — precisely the
    // wrong-action outcome remedyFor exists to prevent.
    ...remedyToHtml(remedy),
  ].join("");

  return {
    subject: headline.subject,
    text,
    html,
  };
}

/**
 * Redis key holding the verdict we last emailed about, and the window after
 * which an UNCHANGED verdict is re-asserted.
 *
 * The window is what stops this being a "tell me once" design: an outage that
 * lasts a week must not go silent after its first email. 24 h means one
 * reminder a day, which is enough to keep it on someone's radar and not enough
 * to train anyone to ignore the subject line.
 */
export const CANARY_ALERT_KEY = "observability:canary:last-alerted-verdict";
export const CANARY_ALERT_REASSERT_MS = 24 * 60 * 60 * 1000;

/**
 * Durable "what did we last tell them" store. Injected so the gate is testable
 * without Redis, mirroring how `probeSentryIngest` takes an injected `send`.
 */
export interface AlertStateStore {
  get(): Promise<string | null>;
  set(value: string, ttlMs: number): Promise<void>;
}

/**
 * The real store.
 *
 * Why Redis and not a module-level variable: this runs on a 30-minute cron
 * against serverless functions, so the process is almost certainly cold and an
 * in-memory value would be reset before the next run — the gate would re-arm
 * every time and suppress nothing. The probe itself still has no Redis
 * dependency (it runs and reports regardless); only the suppression consults it.
 *
 * Why `lib/redis`'s default export rather than a new client: it carries the
 * circuit breaker, so a walled-off Redis fails fast instead of adding latency
 * to a check whose whole job is to be fast.
 */
export function redisAlertStateStore(): AlertStateStore {
  return {
    async get() {
      const value = await redis.get<string>(CANARY_ALERT_KEY);
      return value ?? null;
    },
    async set(value, ttlMs) {
      await redis.set(CANARY_ALERT_KEY, value, { px: ttlMs });
    },
  };
}

/**
 * Should this verdict be emailed?
 *
 * One email per distinct state, re-armed the moment the state changes, and
 * re-asserted at most once per {@link CANARY_ALERT_REASSERT_MS} while it
 * persists. A verdict that changes from `rate-limited` to `rejected-auth`
 * alerts immediately, because that is new information.
 *
 * FAILS OPEN, deliberately, and this is the one place in the canary where that
 * is the right direction. If the store is unreachable the answer is "yes, send":
 * a duplicate email costs a glance, a suppressed one costs an outage nobody
 * was told about — which is the exact failure this whole canary exists to
 * prevent, and the reason it must never be able to silence itself. The
 * `notify-ops-failure.sh` guard reaches the opposite conclusion about its own
 * check for the same underlying reason: a sink that can silently skip is a dead
 * sink nobody sees.
 */
export async function canaryAlertNeeded(
  verdict: string,
  store: AlertStateStore = redisAlertStateStore(),
): Promise<boolean> {
  try {
    return (await store.get()) !== verdict;
  } catch (err) {
    console.error(
      "[sentry-ingest-canary] alert state unavailable, sending anyway:",
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}

/**
 * Arm the cooldown — called ONLY after the alert was actually sent.
 *
 * Split from {@link canaryAlertNeeded} deliberately, and the separation is the
 * fix. An earlier version read the state and wrote the new verdict in one
 * step, before the send was attempted, so a single failed delivery — the email
 * provider down, a `deliver` throw — armed a 24-hour suppression for a
 * verdict nobody had been told about. The canary would then stay silent about
 * broken ingest for a day, which is the exact failure this whole mechanism
 * exists to prevent, arrived at by the alerting itself.
 *
 * Arming on success only means the two remaining failure modes both cost a
 * duplicate email rather than a missed alert: a send that succeeds and a
 * cooldown write that then fails, and a healthy run that races another. That
 * is the right direction for both.
 */
export async function recordCanaryAlertSent(
  verdict: string,
  store: AlertStateStore = redisAlertStateStore(),
): Promise<void> {
  try {
    await store.set(verdict, CANARY_ALERT_REASSERT_MS);
  } catch (err) {
    console.error(
      "[sentry-ingest-canary] could not arm the alert cooldown:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The one-paragraph ops chat twin of the alert email: verdict, cause, remedy. */
export function buildAlertChatText(r: IngestProbeResult): string {
  const { subject } = buildAlertEmail(r);
  const remedy = remedyFor(r).replace(/\s+/g, " ").trim();
  return `${subject}. ${describeIngest(r)} ${remedy}`;
}

/**
 * Send the alert, and mirror it to ops chat once the email is sent. Returns
 * whether the provider took the email.
 *
 * Never throws: the caller is a canary whose job is to report a verdict, and
 * the verdict has to survive the alert channel being down as well.
 */
export async function sendSentryIngestAlert(
  r: IngestProbeResult,
): Promise<boolean> {
  const { subject, text, html } = buildAlertEmail(r);
  const result = await deliver(
    {
      from: SENDERS.ops,
      to: canaryAlertRecipient(),
      replyTo: OPS_EMAIL,
      subject,
      text,
      html,
    },
    "sentry-ingest-canary",
    {
      // Ties the dead-letter row to this specific probe, so a replay after the
      // cause is fixed traces back to the event that reported it.
      entityRef: `sentry-ingest-canary:${r.eventId}`,
      budgetMs: EMAIL_BUDGET_MS.JOB,
    },
  );
  if (result.success) await postOpsChat(buildAlertChatText(r));
  return result.success;
}
