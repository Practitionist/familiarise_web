/**
 * Cron: MSME Section 43B(h) payment-deadline alerts.
 *
 * STATUS: live (body + derivation). `lib/compliance/msme.ts`
 * (`computeMsmePaymentDeadline`) implements the real 15/45-day MICRO/
 * SMALL rule and falls back to `contract.defaultTermsDays` for MEDIUM/
 * NONE. The pipeline below:
 *
 *   1. Query OrganizationPayout rows within 5 days of `mustPayByDate`
 *      that haven't yet COMPLETED.
 *   2. If any exist, email the finance inbox (env: `MSME_ALERT_EMAIL`)
 *      with a deadline-sorted list + direct links into the finance
 *      dashboard.
 *   3. Emit a structured log line that Cloud Logging can route to the
 *      #finance-alerts channel via its built-in sink.
 *
 * Schedule: daily at 04:30 UTC (10:00 IST).
 * GH Actions: `.github/workflows/cron-daily.yml` (daily 03:00 UTC).
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. See
// docs/enterprise/50-operations/02-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import { deliver, EMAIL_BUDGET_MS, SENDERS } from "@/lib/email";
import { OPS_EMAIL } from "@/lib/email/config";
import { sendComplianceAlertEmail } from "@/lib/email/senders/onboarding";
import { notifyComplianceAlert } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

const ALERT_WINDOW_DAYS = 5;
const MAX_ROWS_IN_EMAIL = 20;

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function runMsmePaymentAlerts(): Promise<{
  alerted: number;
  atRisk: number;
  emailSent: boolean;
}> {
  return withCronLock("msme-payment-alerts", { failMode: "open" }, () =>
    runMsmePaymentAlertsUnlocked(),
  );
}

async function runMsmePaymentAlertsUnlocked(): Promise<{
  alerted: number;
  atRisk: number;
  emailSent: boolean;
}> {
  Sentry.logger.info("job:msme-payment-alerts started");
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + ALERT_WINDOW_DAYS);

  // Both payout paths carry a 43B(h) deadline: OrganizationPayout (HOST/ORG
  // recipient) and ConsultantPayout (SELF recipient, #776). Sweep both and
  // merge so the SELF path can't silently miss the statutory window.
  const [orgRows, selfRows] = await Promise.all([
    prisma.organizationPayout.findMany({
      where: {
        mustPayByDate: { lte: windowEnd, not: null },
        status: { notIn: ["COMPLETED"] },
      },
      orderBy: { mustPayByDate: "asc" },
      take: MAX_ROWS_IN_EMAIL + 1,
      select: {
        id: true,
        mustPayByDate: true,
        amountPaise: true,
        status: true,
        organizationId: true,
      },
    }),
    prisma.consultantPayout.findMany({
      where: {
        mustPayByDate: { lte: windowEnd, not: null },
        status: { notIn: ["COMPLETED"] },
      },
      orderBy: { mustPayByDate: "asc" },
      take: MAX_ROWS_IN_EMAIL + 1,
      select: {
        id: true,
        mustPayByDate: true,
        amount: true, // ConsultantPayout stores paise in `amount`
        status: true,
        consultantProfileId: true,
      },
    }),
  ]);

  // Normalize to one shape (org id vs consultant id → `ownerId`) so the
  // email/log treat both uniformly.
  const atRiskRows = [
    ...orgRows.map((r) => ({
      id: r.id,
      mustPayByDate: r.mustPayByDate,
      amountPaise: r.amountPaise,
      status: r.status as string,
      ownerId: r.organizationId ?? "(none)",
    })),
    ...selfRows.map((r) => ({
      id: r.id,
      mustPayByDate: r.mustPayByDate,
      amountPaise: r.amount,
      status: r.status as string,
      ownerId: r.consultantProfileId,
    })),
  ].sort(
    (a, b) =>
      (a.mustPayByDate?.getTime() ?? 0) - (b.mustPayByDate?.getTime() ?? 0),
  );

  const atRisk = atRiskRows.length;
  if (atRisk === 0) {
    console.log("[MSME] no payouts in alert window");
    return { alerted: 0, atRisk: 0, emailSent: false };
  }

  // Structured log for Cloud Logging → #finance-alerts sink.
  console.warn(
    `[MSME] ${atRisk} payouts within ${ALERT_WINDOW_DAYS}d of Section 43B(h) deadline`,
    {
      event: "msme.payout.at_risk",
      count: atRisk,
      windowDays: ALERT_WINDOW_DAYS,
      windowEnd: windowEnd.toISOString(),
    },
  );

  const to = process.env.MSME_ALERT_EMAIL;
  const appUrl = getAppUrl();
  const dashboardUrl = `${appUrl}/dashboard/admin/compliance?tab=msme`;
  const earliestDeadline = atRiskRows[0].mustPayByDate ?? windowEnd;
  const title = `[MSME 43B(h)] ${atRisk} payouts approaching deadline`;
  const summaryReason = `${atRisk} payout(s) within ${ALERT_WINDOW_DAYS} days of their Section 43B(h) deadline are not yet COMPLETED.`;

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
      obligationType: "MSME_SECTION_43BH",
      dueDate: earliestDeadline.toISOString(),
      dashboardUrl,
    });
  } catch (err) {
    console.error("[MSME] Novu compliance alert failed:", err);
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "msme-payment-alerts" },
    });
  }

  try {
    const sendRes = await sendComplianceAlertEmail({
      recipientUserIds,
      alertId: atRiskRows[0].id,
      title,
      dueDate: earliestDeadline,
      reason: summaryReason,
      dashboardUrl,
    });
    emailSent = sendRes.sent > 0;
  } catch (err) {
    console.error("[MSME] user compliance alert email failed:", err);
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "msme-payment-alerts" },
    });
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
        "MSME_PAYMENT_ALERT",
        { budgetMs: EMAIL_BUDGET_MS.JOB },
      );
      if (outcome.success) {
        emailSent = true;
      }
    } catch (err) {
      console.error("[MSME] direct alert email failed:", err);
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "msme-payment-alerts" },
      });
    }
  }

  const result = { alerted: emailSent ? atRisk : 0, atRisk, emailSent };
  Sentry.logger.info("job:msme-payment-alerts finished", {
    alerted: result.alerted,
    atRisk: result.atRisk,
    emailSent: result.emailSent,
  });
  return result;
}

// Self-execute when invoked directly via `npx tsx`. Allows imports for
// unit tests without triggering the cron body.
if (require.main === module) {
  runJob("msme-payment-alerts", async () => {
    await abortIfMaintenance("msme-payment-alerts");
    try {
      const r = await runMsmePaymentAlerts();
      console.log(
        `[MSME] cron done — alerted=${r.alerted} atRisk=${r.atRisk} emailSent=${r.emailSent}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
}
