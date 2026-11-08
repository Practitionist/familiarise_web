/**
 * Bounded invoice dunning claims and notices, with gateway read-back before
 * config-enabled suspension. Every claim repeats its expected prior state and
 * stages its bell and email outbox rows in the same transaction; the email
 * renders before the claim opens.
 */

import prisma, { type Tx } from "@/lib/prisma";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatAuditDate } from "@/lib/labels/org-labels";
import {
  notifyOrgInvoiceOverdue,
  rosterForOrg,
  VISIBILITY_ROLES,
} from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import {
  attemptStaged,
  EMAIL_BUDGET_MS,
  MONEY_EMAIL_TYPES,
  prepareOrgInvoiceOverdueEmail,
  stageOrgInvoiceOverdueEmail,
  type OrgInvoiceOverdueEmailArgs,
  type StagedRecipientEmail,
} from "@/lib/email";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import { readRazorpayOrderHolding } from "@/lib/payments/core/razorpay";
import {
  applyOrgInvoiceCapture,
  invoiceOutstandingPaise,
} from "@/lib/payments/billing/org-invoice-settlement";
import {
  DUNNABLE_ORG_STATUSES,
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
} from "@/lib/payments/billing/dunning-policy";

// #812 — Stage 3 (config-gated). After the 3rd reminder, if the invoice is
// still OVERDUE this long past being marked overdue, suspend the org's
// sponsored bookings by stamping `dunningSuspendedAt`. OFF by default — the
// cascade only runs when ENABLE_DUNNING_SUSPEND=true, so wiring it changes
// nothing until explicitly enabled. The booking-side gate lives in
// lib/payments/checkout/org-funding.ts behind the SAME flag.
const SUSPEND_ENABLED = ENABLE_DUNNING_SUSPEND;
const SUSPEND_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7d past the final reminder
// Turning suspension on must not suspend the whole OVERDUE backlog in one window.
const MAX_SUSPENSIONS_PER_RUN = 20;

interface DunningStats {
  scannedStage1: number;
  markedOverdue: number;
  scannedStage2: number;
  remindersSent: number;
  suspended: number;
  failed: number;
}

interface OverdueInvoice {
  id: string;
  organizationId: string;
  invoiceNumber: string;
  totalPaise: number;
  displayCurrency: string;
  dueDate: Date;
  organization: { name: string };
}

interface OverdueNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

function overdueEmailArgs(
  inv: OverdueInvoice,
  roster: string[],
  reminderStage: number,
  now: Date,
): OrgInvoiceOverdueEmailArgs {
  return {
    recipientUserIds: roster,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    orgName: inv.organization.name,
    totalPaise: inv.totalPaise,
    currency: inv.displayCurrency,
    dueDate: inv.dueDate,
    daysLate: daysBetween(inv.dueDate, now),
    reminderStage,
    payUrl: overduePayUrl(inv),
  };
}

function overduePayUrl(inv: OverdueInvoice): string {
  return `${getAppUrl()}/dashboard/organization/${inv.organizationId}/billing`;
}

/** Renders the overdue email before the claim; null leaves the render to the claim itself. */
async function prepareOverdueEmail(
  inv: OverdueInvoice,
  reminderStage: number,
  now: Date,
): Promise<PreparedSpecEmails | null> {
  try {
    const roster = await rosterForOrg(inv.organizationId, VISIBILITY_ROLES);
    if (roster.length === 0) return null;
    return await prepareOrgInvoiceOverdueEmail(
      overdueEmailArgs(inv, roster, reminderStage, now),
    );
  } catch {
    return null;
  }
}

/**
 * Stages the bell and email in the claim's `tx`, keyed per invoice and stage so
 * a replay cannot stage twice. A roster or read failure rolls the claim back; a
 * render failure stages a `review:render_failed` row and the claim commits.
 */
async function stageOverdueNotices(
  tx: Tx,
  inv: OverdueInvoice,
  reminderStage: number,
  now: Date,
  pre: PreparedSpecEmails | null,
): Promise<OverdueNotices> {
  const daysLate = daysBetween(inv.dueDate, now);
  const payUrl = overduePayUrl(inv);
  const bells = await notifyOrgInvoiceOverdue(
    inv.organizationId,
    {
      invoiceNumber: inv.invoiceNumber,
      orgName: inv.organization.name,
      totalPaise: inv.totalPaise,
      currency: inv.displayCurrency,
      daysLate,
      reminderStage,
      payUrl,
    },
    {
      tx,
      dedupeKey: `orgInvoice:${inv.id}:overdue:${reminderStage}`,
      entityRef: `orgInvoice:${inv.id}`,
    },
  );
  const roster = await rosterForOrg(inv.organizationId, VISIBILITY_ROLES, tx);
  const emails =
    roster.length === 0
      ? []
      : await stageOrgInvoiceOverdueEmail(
          tx,
          overdueEmailArgs(inv, roster, reminderStage, now),
          pre,
        );
  return { bells, emails };
}

/** After commit; a failed send leaves its outbox row for the relays. */
async function attemptOverdueNotices(notices: OverdueNotices): Promise<void> {
  await Promise.allSettled([
    ...notices.bells.map((bell) => attemptTrigger(bell)),
    attemptStaged(
      notices.emails,
      MONEY_EMAIL_TYPES.ORG_INVOICE_OVERDUE,
      EMAIL_BUDGET_MS.JOB,
    ),
  ]);
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// S3776 — the claim-wrap pattern (retry transient aborts, skip-and-log persistent
// ones) shared by all three stages; extracted from the stage loops so
// runDunning stays under the cognitive-complexity budget.
async function claimInvoiceGuarded(
  inv: { id: string },
  label: string,
  run: () => Promise<OverdueNotices | null>,
): Promise<OverdueNotices | "lost" | "failed"> {
  try {
    return (await withSerializableRetry(run)) ?? "lost";
  } catch (err) {
    console.error(
      `[dunning] ${label} claim failed for invoice ${inv.id}:`,
      err,
    );
    return "failed";
  }
}

/** Recover retained captured orders before treating an invoice as unpaid. */
async function recoverBeforeSuspension(
  inv: {
    id: string;
    organizationId: string;
    providerPaymentOrderId: string | null;
  },
  deadline: number,
): Promise<boolean> {
  if (!inv.providerPaymentOrderId) return false;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Dunning gateway read budget elapsed");
  const holding = await readRazorpayOrderHolding(
    inv.providerPaymentOrderId,
    Math.min(5_000, remainingMs),
  );
  if (holding.kind === "empty") return false;
  if (holding.kind === "live") {
    throw new Error("Dunning held for an unsettled gateway payment");
  }
  const outcome = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const captured = await applyOrgInvoiceCapture(tx, {
          invoiceId: inv.id,
          gatewayPaymentId: holding.paymentId,
          capturedPaise: holding.amountPaise,
          notesOrganizationId: inv.organizationId,
        });
        if (captured.kind === "PAID") {
          await tx.orgAuditLog.create({
            data: {
              organizationId: captured.settled.organizationId,
              actorMembershipId: null,
              category: "INVOICE",
              action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
              description: `Invoice ${captured.settled.invoiceNumber} paid by dunning gateway recovery`,
              details: {
                invoiceId: inv.id,
                providerPaymentId: holding.paymentId,
              },
            },
          });
        }
        return captured;
      },
      { isolationLevel: "Serializable" },
    ),
  );
  if (outcome.kind === "UNAPPLIED") {
    throw new Error(
      "Dunning held for a captured payment needing operator review",
    );
  }
  return true;
}

export async function runDunning(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<DunningStats> {
  return withCronLock("dunning", { failMode: "closed" }, () => dunning(opts));
}

/** `limit` caps the claims attempted across all three stages. */
async function dunning(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<DunningStats> {
  const stats: DunningStats = {
    scannedStage1: 0,
    markedOverdue: 0,
    scannedStage2: 0,
    remindersSent: 0,
    suspended: 0,
    failed: 0,
  };
  const now = new Date();
  const asOf = opts.windowStart ?? now;
  let attempted = 0;
  const budgetLeft = () =>
    opts.limit === undefined ? undefined : Math.max(0, opts.limit - attempted);
  const claim = async (
    inv: { id: string },
    label: string,
    run: () => Promise<OverdueNotices | null>,
  ): Promise<OverdueNotices | null> => {
    attempted += 1;
    const outcome = await claimInvoiceGuarded(inv, label, run);
    if (outcome === "failed") stats.failed += 1;
    return typeof outcome === "string" ? null : outcome;
  };

  // ── Stage 1: ISSUED past due → OVERDUE first notice ────────────────────
  const newlyOverdue = await prisma.organizationInvoice.findMany({
    where: {
      status: "ISSUED",
      dueDate: { lt: asOf },
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
    orderBy: { dueDate: "asc" },
    take: budgetLeft(),
  });
  stats.scannedStage1 = newlyOverdue.length;

  for (const inv of newlyOverdue) {
    const pre = await prepareOverdueEmail(inv, 0, now);
    // #1132 follow-up — transient P2034 aborts are retried by the house
    // helper; persistent failures skip this invoice so one bad row can't
    // kill the day's run.
    const notices = await claim(inv, "stage", () =>
      prisma.$transaction(
        async (tx) => {
          // Claim the row only if still ISSUED + un-stamped so two replicas
          // don't both flip + notify. Loser sees count 0 and skips.
          const claim = await tx.organizationInvoice.updateMany({
            where: { id: inv.id, status: "ISSUED", markedOverdueAt: null },
            data: { status: "OVERDUE", markedOverdueAt: now },
          });
          if (claim.count === 0) return null;

          await tx.orgAuditLog.create({
            data: {
              organizationId: inv.organizationId,
              actorMembershipId: null,
              targetMembershipId: null,
              category: "INVOICE",
              action: AUDIT_ACTIONS.INVOICE.INVOICE_OVERDUE,
              description: `Invoice ${inv.invoiceNumber} marked overdue (due ${formatAuditDate(inv.dueDate)})`,
              details: {
                invoiceId: inv.id,
                invoiceNumber: inv.invoiceNumber,
                dueDate: inv.dueDate.toISOString(),
                daysLate: daysBetween(inv.dueDate, now),
              },
            },
          });
          return stageOverdueNotices(tx, inv, 0, now, pre);
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
      ),
    );
    if (!notices) continue;
    stats.markedOverdue += 1;
    await attemptOverdueNotices(notices);
  }

  // ── Stage 2: OVERDUE escalation reminders (7-day cadence, cap 3) ────────
  const cutoff = new Date(asOf.getTime() - REMINDER_INTERVAL_MS);
  const stage2Take = budgetLeft();
  const dueForReminder =
    stage2Take === 0
      ? []
      : await prisma.organizationInvoice.findMany({
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
          orderBy: { id: "asc" },
          take: stage2Take,
        });
  stats.scannedStage2 = dueForReminder.length;

  for (const inv of dueForReminder) {
    // The lastDunningReminderAt the claim must still match — the same value
    // we read selected the row, so a concurrent reminder loses the race.
    const priorReminderAt = inv.lastDunningReminderAt;
    const nextStage = inv.dunningReminderCount + 1;
    const pre = await prepareOverdueEmail(inv, nextStage, now);

    // #1132 follow-up — transient P2034 aborts are retried by the house
    // helper; persistent failures skip this invoice so one bad row can't
    // kill the day's run.
    const notices = await claim(inv, "stage", () =>
      prisma.$transaction(
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
          if (claim.count === 0) return null;
          return stageOverdueNotices(tx, inv, nextStage, now, pre);
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
      ),
    );
    if (!notices) continue;
    stats.remindersSent += 1;
    await attemptOverdueNotices(notices);
  }

  // ── Stage 3 (#812, config-gated): suspend sponsored bookings ────────────
  // Once an invoice has had all 3 reminders and is still OVERDUE past the grace
  // window, stamp dunningSuspendedAt. lib/payments/checkout/org-funding.ts
  // blocks the org's NEW sponsored bookings while any such invoice is unpaid
  // (both sides gated on the same ENABLE_DUNNING_SUSPEND flag). Paying the invoice (status leaves OVERDUE)
  // lifts the suspension naturally — nothing un-stamps a paid invoice.
  if (SUSPEND_ENABLED) {
    const suspensionDeadline = Date.now() + 10_000;
    const suspendCutoff = new Date(asOf.getTime() - SUSPEND_GRACE_MS);
    const suspendedThisWindow = opts.windowStart
      ? await prisma.organizationInvoice.count({
          where: { dunningSuspendedAt: { gte: opts.windowStart } },
        })
      : 0;
    const left = budgetLeft();
    const suspendTake = Math.max(
      0,
      Math.min(
        MAX_SUSPENSIONS_PER_RUN - suspendedThisWindow,
        left ?? MAX_SUSPENSIONS_PER_RUN,
      ),
    );
    const toSuspend =
      suspendTake === 0
        ? []
        : await prisma.organizationInvoice.findMany({
            where: {
              status: "OVERDUE",
              dunningReminderCount: { gte: MAX_REMINDERS },
              dunningSuspendedAt: null,
              // #812 — grace measured from the LAST reminder, not the overdue stamp:
              // the cap-3 reminders span ~21d, so gating on markedOverdueAt suspended
              // the moment the 3rd reminder cleared. lastDunningReminderAt is the
              // Stage-2 cadence anchor, so suspend only 7d past the final reminder.
              lastDunningReminderAt: { lt: suspendCutoff },
              organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
            },
            select: {
              id: true,
              organizationId: true,
              providerPaymentOrderId: true,
              invoiceNumber: true,
              totalPaise: true,
              displayCurrency: true,
              dueDate: true,
              organization: { select: { name: true } },
            },
            orderBy: { lastDunningReminderAt: "asc" },
            take: suspendTake,
          });
    for (const inv of toSuspend) {
      if (Date.now() >= suspensionDeadline) {
        stats.failed += 1;
        break;
      }
      try {
        if (await recoverBeforeSuspension(inv, suspensionDeadline)) continue;
      } catch (error) {
        stats.failed += 1;
        console.error(
          "[dunning] suspension payment check held:",
          inv.id,
          scrubStringValue(
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }
      // #812 — claim + audit in one Serializable tx, mirroring Stage 1, so two
      // replicas can't both stamp + log. Idempotent claim: only stamp a row
      // still un-suspended + OVERDUE; loser sees count 0 and skips.
      // #1132 follow-up — transient P2034 aborts are retried by the house
      // helper; persistent failures skip this invoice so one bad row can't
      // kill the day's run.
      const pre = await prepareOverdueEmail(inv, MAX_REMINDERS + 1, now);
      const notices = await claim(inv, "stage-3 suspend", () =>
        prisma.$transaction(
          async (tx) => {
            if ((await invoiceOutstandingPaise(tx, inv.id)) <= 0) return null;
            const claim = await tx.organizationInvoice.updateMany({
              where: {
                id: inv.id,
                dunningSuspendedAt: null,
                status: "OVERDUE",
                providerPaymentOrderId: inv.providerPaymentOrderId,
              },
              data: { dunningSuspendedAt: now },
            });
            if (claim.count === 0) return null;

            await tx.orgAuditLog.create({
              data: {
                organizationId: inv.organizationId,
                actorMembershipId: null,
                category: "INVOICE",
                action: AUDIT_ACTIONS.INVOICE.INVOICE_DUNNING_SUSPENDED,
                description: `Invoice ${inv.invoiceNumber} unpaid past dunning grace — org sponsored bookings suspended`,
                details: {
                  invoiceId: inv.id,
                  invoiceNumber: inv.invoiceNumber,
                  totalPaise: inv.totalPaise,
                  currency: inv.displayCurrency,
                },
              },
            });
            return stageOverdueNotices(tx, inv, MAX_REMINDERS + 1, now, pre);
          },
          { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
        ),
      );

      if (!notices) continue;
      stats.suspended += 1;
      await attemptOverdueNotices(notices);
    }
  }

  return stats;
}
