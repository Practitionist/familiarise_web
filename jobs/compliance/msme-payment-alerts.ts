/**
 * Cron: MSME Section 43B(h) payment-deadline alerts — STUB (Issue #681).
 *
 * STATUS: stub. Returns `{ alerted: 0 }` without sending any notifications.
 * Live alerting lands in a follow-up PR.
 *
 * Schedule: daily at 07:00 IST.
 * Scope: every `Payout` with `mustPayByDate <= now + 5 days` and
 *        `status != SUCCEEDED`.
 *
 * See lib/compliance/msme.ts header docblock for the 15/45-day rule logic.
 */

import prisma from "@/lib/prisma";

export async function runMsmePaymentAlerts(): Promise<{ alerted: number }> {
  console.log("[cron][arch4-stub] MSME payment-alerts invoked");

  const fiveDaysFromNow = new Date();
  fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);

  // Arch 4-Modified: OrganizationPayout.mustPayByDate is the field.
  const atRisk = await prisma.organizationPayout.count({
    where: {
      mustPayByDate: { lte: fiveDaysFromNow, not: null },
      status: { notIn: ["COMPLETED"] },
    },
  });

  if (atRisk > 0) {
    console.warn(
      `[MSME] ${atRisk} payouts approaching Section 43B(h) deadline; surface to finance dashboard (stub).`,
    );
  }

  return { alerted: 0 };
}
