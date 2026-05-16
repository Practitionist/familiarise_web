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
 * GH Actions: `.github/workflows/msme-payment-alerts.yml`.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. See
// docs/enterprise/23-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "@/lib/prisma";
import { Resend } from "resend";
import { getAppUrl } from "@/lib/url";

const ALERT_WINDOW_DAYS = 5;
const MAX_ROWS_IN_EMAIL = 20;

export async function runMsmePaymentAlerts(): Promise<{
  alerted: number;
  atRisk: number;
  emailSent: boolean;
}> {
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + ALERT_WINDOW_DAYS);

  // Arch 4-Modified: OrganizationPayout.mustPayByDate is the field.
  const atRiskRows = await prisma.organizationPayout.findMany({
    where: {
      mustPayByDate: { lte: windowEnd, not: null },
      status: { notIn: ["COMPLETED"] },
    },
    orderBy: { mustPayByDate: "asc" },
    take: MAX_ROWS_IN_EMAIL + 1, // fetch one extra to detect truncation
    select: {
      id: true,
      mustPayByDate: true,
      amountPaise: true,
      status: true,
      organizationId: true,
    },
  });

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

  // Email dispatch — opt-in per environment so we don't spam finance
  // during staging/preview deploys. The log above is always emitted.
  const to = process.env.MSME_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  let emailSent = false;
  if (to && apiKey) {
    try {
      const resend = new Resend(apiKey);
      const rowsToShow = atRiskRows.slice(0, MAX_ROWS_IN_EMAIL);
      const truncated = atRiskRows.length > MAX_ROWS_IN_EMAIL;
      const appUrl = getAppUrl();
      const tableHtml = rowsToShow
        .map(
          (r) =>
            `<tr><td>${new Date(r.mustPayByDate ?? 0).toISOString().slice(0, 10)}</td>` +
            `<td>${r.id}</td>` +
            `<td>${r.organizationId ?? "(none)"}</td>` +
            `<td>₹${((r.amountPaise ?? 0) / 100).toLocaleString("en-IN")}</td>` +
            `<td>${r.status}</td>` +
            `<td><a href="${appUrl}/admin/payouts/${r.id}">open</a></td></tr>`,
        )
        .join("");
      await resend.emails.send({
        from: "Familiarise Finance <finance@familiarise.com>",
        to,
        subject: `[MSME 43B(h)] ${atRisk} payouts approaching deadline`,
        html:
          `<p>The MSME alert cron found <strong>${atRisk}</strong> payouts ` +
          `within ${ALERT_WINDOW_DAYS} days of their Section 43B(h) deadline ` +
          `and still not in COMPLETED status.</p>` +
          `<table border="1" cellpadding="6" cellspacing="0">` +
          `<thead><tr><th>Deadline</th><th>Payout id</th><th>Org id</th><th>Amount</th><th>Status</th><th></th></tr></thead>` +
          `<tbody>${tableHtml}</tbody></table>` +
          (truncated
            ? `<p>…and ${atRisk - MAX_ROWS_IN_EMAIL} more. Open the finance dashboard for the full list.</p>`
            : ""),
      });
      emailSent = true;
      console.log(`[MSME] alert email sent to ${to}`);
    } catch (err) {
      console.error("[MSME] alert email failed:", err);
    }
  } else {
    console.log(
      "[MSME] MSME_ALERT_EMAIL or RESEND_API_KEY not configured; email skipped",
    );
  }

  return { alerted: emailSent ? atRisk : 0, atRisk, emailSent };
}

// Self-execute when invoked directly via `npx tsx`. Allows imports for
// unit tests without triggering the cron body.
if (require.main === module) {
  runMsmePaymentAlerts()
    .then((r) => {
      console.log(
        `[MSME] cron done — alerted=${r.alerted} atRisk=${r.atRisk} emailSent=${r.emailSent}`,
      );
    })
    .catch((err) => {
      console.error("[MSME] cron failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
