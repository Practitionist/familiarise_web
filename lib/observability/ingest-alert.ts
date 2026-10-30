import { SUPPORT_EMAIL } from "@/lib/company";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "@/lib/email/config";
import { deliver } from "@/lib/email/deliver";
import { emitTelemetryLog } from "./betterstack-telemetry";
import {
  describeIngest,
  isQuotaExhausted,
  type IngestCheck,
} from "./ingest-canary";
import { postOpsChat } from "./ops-chat";

/** Owner address for observability alerts; defaults to the support mailbox. */
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

/** Per verdict, so a throttle is never answered with a plan upgrade. */
function remedyFor(r: IngestCheck): string[] {
  // The read covers the last day, so a re-run stays unhealthy until old rejections age out.
  const recheck =
    "To confirm recovery, read the same stats_v2 query with statsPeriod=1h: rejections already counted stay in the canary's one-day window, so a re-run can stay unhealthy for up to a day after the fix.";
  if (r.verdict === "stats-unreadable") {
    return [
      "Ingest health is unknown, not known bad. Check that SENTRY_STATS_TOKEN is a live org token with org:read, and that SENTRY_API_URL and SENTRY_ORG name the right organisation.",
      "After fixing it, re-run sentry-ingest-canary from the System Jobs page.",
    ];
  }
  if (isQuotaExhausted(r)) {
    return [
      "The error allowance for the billing period is spent, so every new error is discarded until it renews. Triage the top issues by event count, or raise the plan (Team includes 50k errors a month).",
      recheck,
    ];
  }
  return [
    "Sentry is throttling errors but the allowance is not spent. A short-window throttle or Spike Protection clears on its own; do not buy a plan for it. Look for the issue that spiked.",
    recheck,
  ];
}

function subjectFor(r: IngestCheck): string {
  return r.verdict === "stats-unreadable"
    ? "[Familiarise] Sentry stats read failed — ingest health unknown"
    : "[Familiarise] Sentry is rejecting error events";
}

export function buildAlertEmail(r: IngestCheck): {
  subject: string;
  text: string;
  html: string;
} {
  const summary = describeIngest(r);
  const remedy = remedyFor(r);
  return {
    subject: subjectFor(r),
    text: [summary, "", ...remedy].join("\n"),
    html: [
      `<p style="margin:0 0 12px">${escapeHtml(summary)}</p>`,
      ...remedy.map((p) => `<p style="margin:12px 0 0">${escapeHtml(p)}</p>`),
    ].join(""),
  };
}

/** The one-paragraph ops chat twin of the alert email. */
export function buildAlertChatText(r: IngestCheck): string {
  return `${subjectFor(r)}. ${describeIngest(r)} ${remedyFor(r).join(" ")}`;
}

/**
 * Pages outside Sentry: an email through `deliver()` and an error-level Better
 * Stack log line, plus the ops chat mirror. Returns whether the email was taken.
 */
export async function sendSentryIngestAlert(r: IngestCheck): Promise<boolean> {
  const { subject, text, html } = buildAlertEmail(r);
  const [email] = await Promise.all([
    deliver(
      {
        from: SENDERS.ops,
        to: canaryAlertRecipient(),
        replyTo: SUPPORT_EMAIL,
        subject,
        text,
        html,
      },
      "sentry-ingest-canary",
      {
        entityRef: `sentry-ingest-canary:${new Date().toISOString().slice(0, 10)}`,
        budgetMs: EMAIL_BUDGET_MS.JOB,
      },
    ).catch((err: unknown) => {
      console.error(
        "[sentry-ingest-canary] alert email failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { success: false as const };
    }),
    emitTelemetryLog({
      level: "error",
      message: "sentry-ingest-canary unhealthy",
      category: "OBSERVABILITY",
      context: {
        verdict: r.verdict,
        accepted: r.accepted,
        rejections: r.rejections,
        detail: r.detail,
      },
    }),
  ]);
  if (email.success) await postOpsChat(buildAlertChatText(r));
  return email.success;
}
