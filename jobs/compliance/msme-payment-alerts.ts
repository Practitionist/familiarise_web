/**
 * Cron: MSME Section 43B(h) payment-deadline alerts.
 *
 * STATUS: plumbing live. The deadline DERIVATION itself is still a
 * stub (see `lib/compliance/msme.ts` — returns a 60-day default), but
 * the ALERT pipeline is real:
 *
 *   1. Query OrganizationPayout rows within 5 days of `mustPayByDate`
 *      that haven't yet COMPLETED.
 *   2. If any exist, email the finance inbox (env: `MSME_ALERT_EMAIL`)
 *      with a deadline-sorted list + direct links into the finance
 *      dashboard.
 *   3. Emit a structured log line that Cloud Logging can route to the
 *      #finance-alerts channel via its built-in sink.
 *
 * The derivation stub means `mustPayByDate` is over-generous today
 * (org-default terms instead of the 15/45-day rule). That is intentional:
 * an over-wide window produces false positives — finance acts on them,
 * closing the loop — and never under-alerts. When the live derivation
 * lands, the alert volume will shrink, not grow.
 *
 * Schedule: daily at 07:00 IST.
 *
 * See lib/compliance/msme.ts header docblock for the 15/45-day rule
 * live-implementation plan.
 */

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
