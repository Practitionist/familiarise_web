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

import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "@/lib/email/config";
import { deliver } from "@/lib/email/deliver";
import { describeIngest, type IngestProbeResult } from "./ingest-canary";

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

const REMEDY = [
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
  "  - Then re-check: POST /api/cleanup/sentry-ingest-canary with the",
  "    CRON_SECRET bearer. A healthy:true body means ingest is back.",
  "",
  "Reference: lib/observability/ingest-canary.ts",
].join("\n");

/** Exported for the test to assert on, rather than matching a live send. */
export function buildAlertEmail(r: IngestProbeResult): {
  subject: string;
  text: string;
  html: string;
} {
  const summary = describeIngest(r);
  const rows = rowsFor(r);

  const text = [
    "Sentry is not accepting error events.",
    "",
    summary,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    REMEDY,
  ].join("\n");

  const html = [
    `<h2 style="margin:0 0 12px">Sentry is not accepting error events</h2>`,
    `<p style="margin:0 0 12px">${escapeHtml(summary)}</p>`,
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">`,
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="border:1px solid #ddd"><b>${escapeHtml(k)}</b></td>` +
        `<td style="border:1px solid #ddd"><code>${escapeHtml(v)}</code></td></tr>`,
    ),
    `</table>`,
    `<p style="margin:12px 0 0">${escapeHtml(REMEDY.split("\n\n")[0])}</p>`,
    `<p style="margin:12px 0 0">If the rate-limit header names <code>error_usage_exceeded</code>, the billing period's error allowance is spent. Upgrading the plan raises the ceiling immediately — it does not have to wait for the period to roll over.</p>`,
  ].join("");

  return {
    subject: `[Familiarise] Sentry ingest ${r.verdict} — errors are being discarded`,
    text,
    html,
  };
}

/**
 * Send the alert. Returns whether the provider took it.
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
      from: SENDERS.system,
      to: canaryAlertRecipient(),
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
  return result.success;
}
