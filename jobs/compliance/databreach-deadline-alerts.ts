/**
 * Cron: DPDP DataBreach 72-hour reporting deadline alerts.
 *
 * The DPDP Act + DPDP Rules 2025 require the Data Fiduciary to report a
 * personal-data breach to the DPB (Data Protection Board) within 72
 * hours of detection. Past that window the breach is a regulatory
 * incident on its own. This cron sweeps `DataBreach` rows that:
 *
 *   - Have `reportedAt = NULL`, AND
 *   - Are within (or past) the 72-hour reporting window.
 *
 * It then dispatches a single batched email to the DPDP-officer inbox
 * (env: `DATABREACH_ALERT_EMAIL`) listing every at-risk row, sorted by
 * `detectedAt` ascending so the most-overdue ones surface first. A
 * structured-log line `event: "dpdp.databreach.deadline"` mirrors the
 * email so Cloud Logging can route to a #security-alerts sink even
 * without the Resend dispatch.
 *
 * Schedule: hourly. The 72-hour deadline is sharp; daily would risk
 * crossing the cutoff between runs. The query is cheap (indexed on
 * `detectedAt` and `reportedAt`).
 *
 * GH Actions: `.github/workflows/cron-intra-day.yml` (hourly at :17).
 *
 * NOTE: this is the alert pipeline only. The actual breach intake form,
 * incident response playbook, and post-72h escalation policy belong to
 * the DPDP epic (#701). When that ships, the email recipient will
 * change to a DPB-portal-aware integration.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. GitHub Actions loads env via
// repo secrets, but local + emergency manual runs would fail. See
// docs/enterprise/50-operations/02-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import { deliver, EMAIL_BUDGET_MS, SENDERS } from "@/lib/email";
import { OPS_EMAIL } from "@/lib/email/config";
import { sendComplianceAlertEmail } from "@/lib/email/senders/onboarding";
import { notifyComplianceAlert } from "@/lib/novu/service";
import { postOpsChat } from "@/lib/observability/ops-chat";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { BREACH_REPORTING_DEADLINE_HOURS } from "@/lib/backoffice/queue-predicates";

// #1527 — one constant, shared with the Compliance page.
const REPORTING_DEADLINE_HOURS = BREACH_REPORTING_DEADLINE_HOURS;
const WARN_HOURS_BEFORE_DEADLINE = 12; // surface breaches when ≤12h remain
const MAX_ROWS_IN_EMAIL = 50;

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function runDataBreachDeadlineAlerts(): Promise<{
  atRisk: number;
  overdue: number;
  emailSent: boolean;
}> {
  return withCronLock("databreach-deadline-alerts", { failMode: "open" }, () =>
    runDataBreachDeadlineAlertsUnlocked(),
  );
}

async function runDataBreachDeadlineAlertsUnlocked(): Promise<{
  atRisk: number;
  overdue: number;
  emailSent: boolean;
}> {
  Sentry.logger.info("job:databreach-deadline-alerts started");
  const now = new Date();
  // Anything detected this far back already has ≤ WARN_HOURS_BEFORE_DEADLINE
  // hours remaining. We pull everything from "deadline minus warn-window"
  // forward through "now" so a single sweep catches both upcoming and
  // overdue rows.
  const warnCutoff = new Date(
    now.getTime() -
      (REPORTING_DEADLINE_HOURS - WARN_HOURS_BEFORE_DEADLINE) * 60 * 60 * 1000,
  );

  const candidates = await prisma.dataBreach.findMany({
    where: {
      reportedAt: null,
      detectedAt: { lte: warnCutoff },
    },
    orderBy: { detectedAt: "asc" },
    take: MAX_ROWS_IN_EMAIL + 1,
    select: {
      id: true,
      detectedAt: true,
      affectedUserIds: true,
      rootCause: true,
      dpbReference: true,
    },
  });

  const overdueCutoff = new Date(
    now.getTime() - REPORTING_DEADLINE_HOURS * 60 * 60 * 1000,
  );
  const overdue = candidates.filter((c) => c.detectedAt < overdueCutoff).length;
  const atRisk = candidates.length;

  if (atRisk === 0) {
    console.log("[DataBreach] no breaches in alert window");
    return { atRisk: 0, overdue: 0, emailSent: false };
  }

  // Structured log — primary alerting channel even when email is unset.
  console.warn(
    `[DataBreach] ${atRisk} breaches near/past 72h DPB deadline (${overdue} overdue)`,
    {
      event: "dpdp.databreach.deadline",
      atRisk,
      overdue,
      reportingDeadlineHours: REPORTING_DEADLINE_HOURS,
    },
  );

  const to = process.env.DATABREACH_ALERT_EMAIL;
  const appUrl = getAppUrl();
  const dashboardUrl = `${appUrl}/dashboard/admin/compliance?tab=breaches`;
  const earliestDeadline = new Date(
    candidates[0].detectedAt.getTime() +
      REPORTING_DEADLINE_HOURS * 60 * 60 * 1000,
  );
  const overdueSuffix = overdue > 0 ? ` — ${overdue} OVERDUE` : "";
  const title = `[DPDP] ${atRisk} breach(es) approaching 72h deadline${overdueSuffix}`;
  const summaryReason = `${atRisk} unreported breach(es) approaching or past the 72-hour DPB reporting deadline under Section 8(6) of the DPDP Act (${overdue} overdue).`;

  const adminUsers = await prisma.user.findMany({
    where: {
      OR: [{ role: "ADMIN" }, ...(to ? [{ email: to }] : [])],
    },
    select: { id: true, email: true },
  });
  const recipientUserIds = adminUsers.map((u) => u.id);

  let emailSent = false;
  try {
    await notifyComplianceAlert(recipientUserIds, {
      title,
      obligationType: "DPDP_DATA_BREACH",
      dueDate: earliestDeadline.toISOString(),
      dashboardUrl,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "databreach-deadline-alerts" },
    });
    console.error("[DataBreach] Novu compliance alert failed:", err);
  }

  try {
    const sendRes = await sendComplianceAlertEmail({
      recipientUserIds,
      alertId: candidates[0].id,
      title,
      dueDate: earliestDeadline,
      reason: summaryReason,
      dashboardUrl,
    });
    emailSent = sendRes.sent > 0;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "databreach-deadline-alerts" },
    });
    console.error("[DataBreach] user compliance alert email failed:", err);
  }

  if (
    to &&
    !adminUsers.some((u) => u.email?.toLowerCase() === to.toLowerCase())
  ) {
    try {
      const outcome = await deliver(
        {
          from: SENDERS.ops,
          to,
          replyTo: OPS_EMAIL,
          subject: title,
          html: `<p>${summaryReason}</p><p><a href="${dashboardUrl}">Open compliance dashboard</a></p>`,
        },
        "DATABREACH_DEADLINE_ALERT",
        { budgetMs: EMAIL_BUDGET_MS.JOB },
      );
      if (outcome.success) {
        emailSent = true;
      }
    } catch (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "databreach-deadline-alerts" },
      });
      console.error("[DataBreach] direct alert email failed:", err);
    }
  }

  try {
    const overdueClause = overdue > 0 ? `, ${overdue} of them OVERDUE` : "";
    await postOpsChat(
      `[DPDP] ${atRisk} unreported data breach(es) are approaching or past the 72-hour DPB reporting deadline` +
        `${overdueClause}. ` +
        `Report each one to the Data Protection Board under Section 8(6) of the DPDP Act and record its DPB reference: ` +
        dashboardUrl,
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "databreach-deadline-alerts" },
    });
    console.error("[DataBreach] Ops Chat alert failed:", err);
  }

  Sentry.logger.info("job:databreach-deadline-alerts finished", {
    atRisk,
    overdue,
    emailSent,
  });
  return { atRisk, overdue, emailSent };
}

// Self-execute when invoked directly via `npx tsx`.
if (require.main === module) {
  runJob("databreach-deadline-alerts", async () => {
    await abortIfMaintenance("databreach-deadline-alerts");
    try {
      const r = await runDataBreachDeadlineAlerts();
      console.log(
        `[DataBreach] cron done — atRisk=${r.atRisk} overdue=${r.overdue} emailSent=${r.emailSent}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
}
