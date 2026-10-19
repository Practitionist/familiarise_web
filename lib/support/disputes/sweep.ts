import prisma from "@/lib/prisma";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { deliver } from "@/lib/email";
import { DEFAULT_FROM_ADDRESS, EMAIL_BUDGET_MS } from "@/lib/email";
import { goHref } from "@/lib/dashboard/go";
import { escalateForMissedWindow } from "./actions";
import { COMPLAINT_REDRESSAL_DAYS } from "./deadlines";

/** HTML-escape, for the email bodies. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The dispute sweep.
 *
 * Two jobs, both about a deadline that would otherwise pass silently:
 *
 *  1. A respondent who missed their answer window hands the dispute to the
 *     platform. The escalation is a conditional update on
 *     `{status: "OPEN", respondentDueAt < now}`, so a respondent answering at
 *     the same moment wins and the sweep no-ops — never the other way round.
 *
 *  2. A claim approaching the statutory redressal deadline is flagged to the
 *     platform, so a case about to breach the CP (E-Commerce) Rules' one-month
 *     window is visible BEFORE it breaches, not after.
 *
 * One job, registered once in `lib/cron/cleanup-registry.ts` — never a
 * `jobs/**` + `scripts/**` + `app/api/cleanup/**` trio.
 */

/** A claim within this window of the statutory redressal deadline. */
const AT_RISK_DAYS = 5;

export interface DisputeSweepResult {
  /** False when a row failed, so the job reports a 500 rather than a clean 200. */
  success: boolean;
  scanned: number;
  escalated: number;
  atRiskNotified: number;
  errors: string[];
}

export async function runDisputeSweep(options?: {
  limit?: number;
  now?: Date;
}): Promise<DisputeSweepResult> {
  const limit = options?.limit ?? 100;
  const now = options?.now ?? new Date();
  const errors: string[] = [];
  let scanned = 0;
  let escalated = 0;
  let atRiskNotified = 0;

  // 1. The respondent's window has passed.
  const overdue = await prisma.purchaseDispute.findMany({
    where: { status: "OPEN", respondentDueAt: { lt: now } },
    orderBy: { respondentDueAt: "asc" },
    take: limit,
    select: {
      id: true,
      referenceNumber: true,
      version: true,
      buyerUserId: true,
      supportCase: { select: { referenceNumber: true, title: true } },
    },
  });

  for (const dispute of overdue) {
    scanned += 1;
    try {
      const moved = await prisma.$transaction(async (tx) => {
        const escalatedNow = await escalateForMissedWindow(tx, dispute.id, now);
        if (!escalatedNow) return false;
        await tx.purchaseDisputeAction.create({
          data: {
            disputeId: dispute.id,
            clientActionId: `sweep:missed-window:${dispute.id}:${dispute.version}`,
            kind: "ESCALATED",
            fromStatus: "OPEN",
            toStatus: "ESCALATED",
            payload: { reason: "RESPONDENT_WINDOW_PASSED" },
          },
        });
        await stageBell(tx, {
          workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
          recipients: [dispute.buyerUserId],
          dedupeKey: `dispute-escalated:${dispute.id}`,
          entityRef: `dispute:${dispute.id}`,
          payload: {
            ticketId: dispute.supportCase.referenceNumber,
            reference: dispute.referenceNumber,
            ticketTitle: dispute.supportCase.title,
            status: "Escalated — our team is reviewing this now",
            // The buyer's own claim, in the buyer's own dashboard: the admin
            // queue is not a page a buyer can open.
            dashboardUrl: goHref(
              "client",
              `disputes/${dispute.referenceNumber}`,
            ),
          },
        });
        return true;
      });
      if (moved) escalated += 1;
    } catch (error) {
      errors.push(
        `Dispute ${dispute.referenceNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 2. A claim nearing the statutory redressal deadline. The platform is
  // told, not the buyer: the buyer is told when there is an answer to give.
  // The claim is due at createdAt + COMPLAINT_REDRESSAL_DAYS, so it is at
  // risk within AT_RISK_DAYS of that — a cutoff in the PAST, measured back
  // from now.
  const atRiskCutoff = new Date(
    now.getTime() - (COMPLAINT_REDRESSAL_DAYS - AT_RISK_DAYS) * 24 * 3_600_000,
  );
  const atRisk = await prisma.purchaseDispute.findMany({
    where: {
      status: { in: ["OPEN", "RESPONDED", "ESCALATED", "UNDER_REVIEW"] },
      createdAt: { lt: atRiskCutoff },
      resolvedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      referenceNumber: true,
      createdAt: true,
      amountAtStakePaise: true,
      supportCase: { select: { referenceNumber: true, title: true } },
    },
  });

  if (atRisk.length > 0) {
    const admins = await prisma.user.findMany({
      where: { role: { in: ["ADMIN", "STAFF"] } },
      select: { id: true, email: true },
    });
    const recipients = admins.map((a) => a.id);

    for (const dispute of atRisk) {
      try {
        const dedupeKey = `dispute-at-risk:${dispute.id}:${dispute.createdAt
          .toISOString()
          .slice(0, 10)}`;
        const staged = await prisma.$transaction(async (tx) => {
          const row = await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
            recipients,
            dedupeKey,
            entityRef: `dispute:${dispute.id}`,
            payload: {
              ticketId: dispute.supportCase.referenceNumber,
              reference: dispute.referenceNumber,
              ticketTitle: dispute.supportCase.title,
              status:
                "This claim is approaching its statutory resolution deadline",
              dashboardUrl: "/dashboard/admin/money/disputes",
            },
          });
          return row !== null;
        });
        if (!staged) continue;
        const subject = `[Dispute At Risk] ${dispute.referenceNumber}`;
        const html = `<p>Dispute <strong>${escapeHtml(dispute.referenceNumber)}</strong> is approaching its statutory resolution deadline. Please review it.</p>`;
        await Promise.allSettled(
          admins
            .filter((admin) => Boolean(admin.email))
            .map((admin) =>
              deliver(
                {
                  from: DEFAULT_FROM_ADDRESS,
                  to: admin.email,
                  subject,
                  html,
                },
                "dispute-at-risk-alert",
                { entityRef: dedupeKey, budgetMs: EMAIL_BUDGET_MS.JOB },
              ),
            ),
        );
        atRiskNotified += 1;
      } catch (error) {
        errors.push(
          `Dispute ${dispute.referenceNumber} (at risk): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    success: errors.length === 0,
    scanned,
    escalated,
    atRiskNotified,
    errors,
  };
}
