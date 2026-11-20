/**
 * After a moderation reject commits: cancel the orders it expired, release the
 * held-time notices, and stage each learner's notice. Never throws; failures
 * collapse into one report for the run.
 */

import prisma from "@/lib/prisma";
import { flushBackupInterestNotices } from "@/lib/booking/backup-interest";
import { stageRequestEndedNotice } from "@/lib/booking/expiry-notices";
import {
  closedRequestNotice,
  type EndedUnpaidSales,
} from "@/lib/booking/unverified-expert-sales";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import { goHref } from "@/lib/dashboard/go";
import { notifyTrialCancelled } from "@/lib/novu/service";
import type { StagedTrigger } from "@/lib/novu/outbox";
import type { StagedEmailBundleEntry } from "@/lib/novu/stage-then-attempt";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";

const OP = "moderation.unverified-expert-sales";

export async function settleEndedUnpaidSales(
  sales: Pick<EndedUnpaidSales, "ended" | "gatewayCancels" | "holdNotices">,
): Promise<{ bells: StagedTrigger[]; emails: StagedEmailBundleEntry[] }> {
  const failures = createRunFailureReporter("moderation");
  const bells: StagedTrigger[] = [];
  const emails: StagedEmailBundleEntry[] = [];

  // A capture that still lands on an expired order is refunded by the capture handler.
  for (const cancel of sales.gatewayCancels) {
    try {
      await cancelPaymentIntent(cancel.paymentIntent, cancel.gateway);
    } catch (error) {
      failures.add(OP, error, { step: "gateway-cancel" }, { expected: true });
    }
  }
  for (const holdNotices of sales.holdNotices) {
    try {
      await flushBackupInterestNotices(holdNotices);
    } catch (error) {
      failures.add(OP, error, { step: "held-time-notices" });
    }
  }

  for (const sale of sales.ended) {
    try {
      if (sale.kind === "trial") {
        const dashboardUrl = goHref("client", "appointments");
        const staged = await notifyTrialCancelled(
          [sale.learnerUserId],
          {
            consultantName: sale.expertName,
            consulteeName: sale.learnerName,
            planTitle: sale.planTitle,
            status: "CANCELLED",
            dateTime: sale.startsAt?.toISOString(),
            dashboardUrl,
          },
          `trial-cancelled:${sale.id}`,
          { tx: prisma },
        );
        bells.push(...staged.flatMap((b) => (b.staged ? [b.staged] : [])));
        const rows = await stageTrialLifecycleEmail(prisma, {
          trialId: sale.id,
          userIds: [sale.learnerUserId],
          kind: "TRIAL_CANCELLED",
          planTitle: sale.planTitle,
          consultantName: sale.expertName,
          consulteeName: sale.learnerName,
          startsAt: sale.startsAt ?? undefined,
          dashboardUrl,
        });
        emails.push({ rows, emailType: "TRIAL_CANCELLED" });
        continue;
      }
      const staged = await stageRequestEndedNotice(
        prisma,
        {
          appointmentId: sale.appointmentId ?? sale.id,
          organizationId: sale.organizationId,
          consultantName: sale.expertName,
          consulteeName: sale.learnerName,
          planTitle: sale.planTitle,
          appointmentType:
            sale.kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
          startsAt: sale.startsAt,
          reason: closedRequestNotice(sale.expertName),
        },
        { recipients: [sale.learnerUserId] },
      );
      bells.push(...staged.bells);
      emails.push({ rows: staged.emails, emailType: "APPOINTMENT_CANCELLED" });
    } catch (error) {
      failures.add(OP, error, { step: "learner-notice", id: sale.id });
    }
  }
  failures.flush();
  return { bells, emails };
}
