/**
 * #779 §A — DUNNING cron. Two stages over OrganizationInvoice:
 *
 *   Stage 1 (first notice): ISSUED + dueDate passed + markedOverdueAt:null
 *     → claim ISSUED→OVERDUE (stamp markedOverdueAt), notify the finance
 *       roster, emit an INVOICE_OVERDUE audit row.
 *   Stage 2 (escalation): OVERDUE rows whose last reminder (or the overdue
 *     stamp) is >7d old AND dunningReminderCount < 3 → claim via the
 *     lastDunningReminderAt gate, bump the count, re-notify with the next
 *     escalation stage.
 *
 * No booking-suspend stage yet — dunningSuspendedAt stays unwritten.
 * TODO(#779): config-gated booking-suspend cascade once OVERDUE drags past
 * the grace window.
 *
 * Schedule: daily at 05:00 IST (`.github/workflows/dunning.yml`), after the
 * invoice-gen + expire-contracts crons so a freshly-issued/expired invoice
 * is in its final state before dunning reads it.
 *
 * Idempotent: every stamp (markedOverdueAt / lastDunningReminderAt) is an
 * idempotency gate baked into the claim updateMany, so two cron replicas or
 * a same-day re-run can't double-notify.
 *
 * Usage:
 *   npx tsx jobs/billing/dunning.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgInvoiceOverdue } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

// #779 — 7-day cadence between escalations, capped at 3 reminders.
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 3;

// #779 — only dun orgs that are still reachable. DEACTIVATED orgs are torn
// down; their invoices don't get chased.
const DUNNABLE_ORG_STATUSES = [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
] as const;

interface DunningStats {
  scannedStage1: number;
  markedOverdue: number;
  scannedStage2: number;
  remindersSent: number;
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export async function runDunning(): Promise<DunningStats> {
  const stats: DunningStats = {
    scannedStage1: 0,
    markedOverdue: 0,
    scannedStage2: 0,
    remindersSent: 0,
  };
  const now = new Date();

  // ── Stage 1: ISSUED past due → OVERDUE first notice ────────────────────
  const newlyOverdue = await prisma.organizationInvoice.findMany({
    where: {
      status: "ISSUED",
      dueDate: { lt: now },
      markedOverdueAt: null,
      organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
    },
    select: {
      id: true,
      organizationId: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      dueDate: true,
      organization: { select: { name: true } },
    },
  });
  stats.scannedStage1 = newlyOverdue.length;

  for (const inv of newlyOverdue) {
    const claimed = await prisma.$transaction(
      async (tx) => {
        // Claim the row only if still ISSUED + un-stamped so two replicas
        // don't both flip + notify. Loser sees count 0 and skips.
        const claim = await tx.organizationInvoice.updateMany({
          where: { id: inv.id, status: "ISSUED", markedOverdueAt: null },
          data: { status: "OVERDUE", markedOverdueAt: now },
        });
        if (claim.count === 0) return false;

        await tx.orgAuditLog.create({
          data: {
            organizationId: inv.organizationId,
            actorMembershipId: null,
            targetMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_OVERDUE,
            description: `Invoice ${inv.invoiceNumber} marked OVERDUE (due ${inv.dueDate.toISOString()})`,
            details: {
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              dueDate: inv.dueDate.toISOString(),
              daysLate: daysBetween(inv.dueDate, now),
            },
          },
        });
        return true;
      },
      { isolationLevel: "Serializable" },
    );

    if (!claimed) continue;
    stats.markedOverdue += 1;

    // Fire-and-forget notify outside the tx — committed state, no DB writes.
    void notifyOrgInvoiceOverdue(inv.organizationId, {
      invoiceNumber: inv.invoiceNumber,
      orgName: inv.organization.name,
      totalPaise: inv.totalPaise,
      currency: inv.displayCurrency,
      daysLate: daysBetween(inv.dueDate, now),
      reminderStage: 0,
      payUrl: `${getAppUrl()}/dashboard/organization/${inv.organizationId}/billing`,
    }).catch((err) => console.error("[dunning] stage-1 notify failed:", err));
  }

  // ── Stage 2: OVERDUE escalation reminders (7-day cadence, cap 3) ────────
  const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_MS);
  const dueForReminder = await prisma.organizationInvoice.findMany({
    where: {
      status: "OVERDUE",
      dunningReminderCount: { lt: MAX_REMINDERS },
      organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
      // next reminder when (now - (lastDunningReminderAt ?? markedOverdueAt)) > 7d
      OR: [
        { lastDunningReminderAt: { lt: cutoff } },
        { lastDunningReminderAt: null, markedOverdueAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      dueDate: true,
      markedOverdueAt: true,
      lastDunningReminderAt: true,
      dunningReminderCount: true,
      organization: { select: { name: true } },
    },
  });
  stats.scannedStage2 = dueForReminder.length;

  for (const inv of dueForReminder) {
    // The lastDunningReminderAt the claim must still match — the same value
    // we read selected the row, so a concurrent reminder loses the race.
    const priorReminderAt = inv.lastDunningReminderAt;
    const nextStage = inv.dunningReminderCount + 1;

    const claimed = await prisma.$transaction(
      async (tx) => {
        const claim = await tx.organizationInvoice.updateMany({
          where: {
            id: inv.id,
            status: "OVERDUE",
            lastDunningReminderAt: priorReminderAt,
            dunningReminderCount: { lt: MAX_REMINDERS },
          },
          data: {
            lastDunningReminderAt: now,
            dunningReminderCount: { increment: 1 },
          },
        });
        return claim.count > 0;
      },
      { isolationLevel: "Serializable" },
    );

    if (!claimed) continue;
    stats.remindersSent += 1;

    void notifyOrgInvoiceOverdue(inv.organizationId, {
      invoiceNumber: inv.invoiceNumber,
      orgName: inv.organization.name,
      totalPaise: inv.totalPaise,
      currency: inv.displayCurrency,
      daysLate: daysBetween(inv.dueDate, now),
      reminderStage: nextStage,
      payUrl: `${getAppUrl()}/dashboard/organization/${inv.organizationId}/billing`,
    }).catch((err) => console.error("[dunning] stage-2 notify failed:", err));
  }

  return stats;
}

async function main() {
  console.log(`[dunning] Starting at ${new Date().toISOString()}`);
  const stats = await runDunning();
  console.log(
    `[dunning] Done. scannedStage1=${stats.scannedStage1} markedOverdue=${stats.markedOverdue} scannedStage2=${stats.scannedStage2} remindersSent=${stats.remindersSent}`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[dunning] Failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
