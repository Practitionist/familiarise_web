import prisma from "@/lib/prisma";
import {
  DISPUTE_RESPONSE_LEAD_MS,
  PENDING_AGE_LIMITS_MS,
} from "@/lib/cron/pending-ages";
import type { PendingAges } from "@/lib/observability/betterstack-telemetry";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import { DEAD_LETTER_EMAIL_WHERE } from "@/lib/backoffice/queue-predicates";
import {
  DUNNABLE_ORG_STATUSES,
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
} from "@/lib/payments/billing/dunning-policy";

/** Rows shown per queue; one more is read so the page can say the list is cut. */
export const ATTENTION_ROW_CAP = 25;
const LAST_ERROR_MAX_CHARS = 200;

export type AttentionQueueKey = keyof PendingAges;

export interface AttentionLink {
  label: string;
  /** Relative to the console's base path, e.g. `money/refunds`. */
  path: string;
}

export interface AttentionItem {
  id: string;
  state: string;
  /** Milliseconds past the item's due point. */
  ageMs: number;
  attempts: number | null;
  lastError: string | null;
  links: AttentionLink[];
}

export interface AttentionQueue {
  key: AttentionQueueKey;
  label: string;
  money: boolean;
  limitMs: number;
  /** What the queue lists beyond items past the limit. */
  note?: string;
  /** Null when the read failed; the other queues still render. */
  items: AttentionItem[] | null;
  capped: boolean;
}

interface AttentionSource {
  key: AttentionQueueKey;
  label: string;
  money: boolean;
  note?: string;
  read: (now: Date, limitMs: number) => Promise<AttentionItem[]>;
}

const take = ATTENTION_ROW_CAP + 1;
const before = (now: Date, ms: number) => new Date(now.getTime() - ms);
const lastError = (text: string | null): string | null =>
  text ? scrubStringValue(text).slice(0, LAST_ERROR_MAX_CHARS) : null;
const tracePayment = (id: string): AttentionLink => ({
  label: "Entity trace",
  path: `trace?kind=payment&id=${encodeURIComponent(id)}`,
});

const STUCK_PAYOUT_STATUSES = ["APPROVED", "PROCESSING"] as const;
const RESPONSE_DUE_DISPUTE_STATUSES = [
  "WARNING_NEEDS_RESPONSE",
  "NEEDS_RESPONSE",
] as const;
const RETRYING = ["PENDING", "RETRY"] as const;

/** Each queue the gauges watch, in the order the page lists them; reads are bounded and read-only. */
const SOURCES: readonly AttentionSource[] = [
  {
    key: "refundsOwed",
    label: "Refunds the bookings owe",
    money: true,
    read: async (now, limitMs) => {
      const rows = await prisma.payment.findMany({
        where: {
          refundOwedKey: { not: null },
          deletedAt: null,
          refundOwedAt: { lte: before(now, limitMs) },
        },
        orderBy: [{ refundOwedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          refundOwedAt: true,
          refundOwedAttempts: true,
          refundOwedReason: true,
        },
      });
      return rows.map((r) => ({
        id: r.id,
        state: "Refund owed",
        ageMs: now.getTime() - (r.refundOwedAt ?? now).getTime(),
        attempts: r.refundOwedAttempts,
        lastError: lastError(r.refundOwedReason),
        links: [
          tracePayment(r.id),
          { label: "Refunds", path: "money/refunds" },
        ],
      }));
    },
  },
  {
    key: "payoutsStuck",
    label: "Payouts approved, in flight or failed",
    money: true,
    note: "Failed payouts are listed at any age.",
    read: async (now, limitMs) => {
      const where = {
        OR: [
          {
            status: { in: [...STUCK_PAYOUT_STATUSES] },
            updatedAt: { lte: before(now, limitMs) },
          },
          { status: "FAILED" as const },
        ],
      };
      const consultant = await prisma.consultantPayout.findMany({
        where,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          status: true,
          updatedAt: true,
          retryCount: true,
          failureReason: true,
        },
      });
      const org = await prisma.organizationPayout.findMany({
        where,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          status: true,
          updatedAt: true,
          failureReason: true,
        },
      });
      return [
        ...consultant.map((p) => ({
          id: p.id,
          state: `Expert payout ${p.status}`,
          ageMs: now.getTime() - p.updatedAt.getTime(),
          attempts: p.retryCount,
          lastError: lastError(p.failureReason),
          links: [{ label: "Payouts", path: "money/payouts" }],
        })),
        ...org.map((p) => ({
          id: p.id,
          state: `Organisation payout ${p.status}`,
          ageMs: now.getTime() - p.updatedAt.getTime(),
          attempts: null,
          lastError: lastError(p.failureReason),
          links: [{ label: "Org payouts", path: "money/org-payouts" }],
        })),
      ]
        .sort((a, b) => b.ageMs - a.ageMs)
        .slice(0, take);
    },
  },
  {
    key: "dunningNotices",
    label: "Overdue invoice notices not sent",
    money: true,
    read: async (now, limitMs) => {
      const reminderDue = before(now, REMINDER_INTERVAL_MS + limitMs);
      const rows = await prisma.organizationInvoice.findMany({
        where: {
          organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
          OR: [
            {
              status: "ISSUED",
              markedOverdueAt: null,
              dueDate: { lte: before(now, limitMs) },
            },
            {
              status: "OVERDUE",
              dunningReminderCount: { lt: MAX_REMINDERS },
              OR: [
                { lastDunningReminderAt: { lte: reminderDue } },
                {
                  lastDunningReminderAt: null,
                  markedOverdueAt: { lte: reminderDue },
                },
              ],
            },
          ],
        },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          dueDate: true,
          markedOverdueAt: true,
          lastDunningReminderAt: true,
          dunningReminderCount: true,
        },
      });
      return rows.map((i) => {
        const anchor = i.lastDunningReminderAt ?? i.markedOverdueAt;
        const duePoint =
          i.status === "ISSUED" || !anchor
            ? i.dueDate.getTime()
            : anchor.getTime() + REMINDER_INTERVAL_MS;
        return {
          id: i.id,
          state:
            i.status === "ISSUED"
              ? `${i.invoiceNumber}: overdue notice not sent`
              : `${i.invoiceNumber}: reminder ${i.dunningReminderCount + 1} not sent`,
          ageMs: now.getTime() - duePoint,
          attempts: i.dunningReminderCount,
          lastError: null,
          links: [{ label: "Invoices", path: "invoices" }],
        };
      });
    },
  },
  {
    key: "disputesDue",
    label: "Disputes inside their response window",
    money: true,
    read: async (now) => {
      const rows = await prisma.dispute.findMany({
        where: {
          status: { in: [...RESPONSE_DUE_DISPUTE_STATUSES] },
          dueBy: { lte: new Date(now.getTime() + DISPUTE_RESPONSE_LEAD_MS) },
        },
        orderBy: [{ dueBy: "asc" }, { id: "asc" }],
        take,
        select: { id: true, paymentId: true, status: true, dueBy: true },
      });
      return rows.map((d) => ({
        id: d.id,
        state: d.status,
        ageMs:
          now.getTime() -
          ((d.dueBy ?? now).getTime() - DISPUTE_RESPONSE_LEAD_MS),
        attempts: null,
        lastError: null,
        links: [
          tracePayment(d.paymentId),
          { label: "Disputes", path: "money/disputes" },
        ],
      }));
    },
  },
  {
    key: "webhookEvents",
    label: "Gateway webhooks not processed",
    money: false,
    note: "Events the sweep gave up on after 7 days stay listed.",
    read: async (now, limitMs) => {
      const rows = await prisma.webhookEvent.findMany({
        where: { processed: false, receivedAt: { lte: before(now, limitMs) } },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          eventType: true,
          receivedAt: true,
          deferCount: true,
          error: true,
        },
      });
      return rows.map((w) => ({
        id: w.id,
        state: w.eventType,
        ageMs: now.getTime() - w.receivedAt.getTime(),
        attempts: w.deferCount,
        lastError: lastError(w.error),
        links: [{ label: "System jobs", path: "system-jobs" }],
      }));
    },
  },
  {
    key: "emailRetries",
    label: "Emails overdue or dead-lettered",
    money: false,
    note: "Dead letters are listed at any age; pre-launch holds are not.",
    read: async (now, limitMs) => {
      const cutoff = before(now, limitMs);
      const rows = await prisma.failedEmail.findMany({
        where: {
          OR: [
            { status: { in: [...RETRYING] }, nextRetryAt: { lte: cutoff } },
            {
              status: { in: [...RETRYING] },
              nextRetryAt: null,
              createdAt: { lte: cutoff },
            },
            DEAD_LETTER_EMAIL_WHERE,
          ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          emailType: true,
          status: true,
          attempts: true,
          lastError: true,
          nextRetryAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((e) => ({
        id: e.id,
        state: `${e.emailType} ${e.status}`,
        ageMs:
          now.getTime() -
          (e.status === "DEAD_LETTER"
            ? e.updatedAt
            : (e.nextRetryAt ?? e.createdAt)
          ).getTime(),
        attempts: e.attempts,
        lastError: lastError(e.lastError),
        links: [{ label: "Compliance", path: "compliance" }],
      }));
    },
  },
  {
    key: "notificationRetries",
    label: "Bell notifications overdue or dead-lettered",
    money: false,
    note: "Dead letters are listed at any age.",
    read: async (now, limitMs) => {
      const cutoff = before(now, limitMs);
      const rows = await prisma.notificationOutbox.findMany({
        where: {
          OR: [
            { status: { in: [...RETRYING] }, nextRetryAt: { lte: cutoff } },
            {
              status: { in: [...RETRYING] },
              nextRetryAt: null,
              createdAt: { lte: cutoff },
            },
            { status: "DEAD_LETTER" },
          ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          workflowId: true,
          status: true,
          attempts: true,
          lastError: true,
          nextRetryAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((n) => ({
        id: n.id,
        state: `${n.workflowId} ${n.status}`,
        ageMs:
          now.getTime() -
          (n.status === "DEAD_LETTER"
            ? n.updatedAt
            : (n.nextRetryAt ?? n.createdAt)
          ).getTime(),
        attempts: n.attempts,
        lastError: lastError(n.lastError),
        links: [{ label: "System jobs", path: "system-jobs" }],
      }));
    },
  },
];

/**
 * The stuck items of every watched queue, oldest first. Read-only: one bounded
 * read per source table (eight statements), in sequence for `PG_POOL_MAX=1`.
 */
export async function readNeedsAttention(
  now = new Date(),
): Promise<AttentionQueue[]> {
  const queues: AttentionQueue[] = [];
  for (const source of SOURCES) {
    const limitMs = PENDING_AGE_LIMITS_MS[source.key];
    let items: AttentionItem[] | null;
    try {
      items = await source.read(now, limitMs);
    } catch (err) {
      console.warn(
        `[needs-attention] ${source.key} read failed:`,
        err instanceof Error ? err.message : String(err),
      );
      items = null;
    }
    queues.push({
      key: source.key,
      label: source.label,
      money: source.money,
      limitMs,
      note: source.note,
      items: items?.slice(0, ATTENTION_ROW_CAP) ?? null,
      capped: (items?.length ?? 0) > ATTENTION_ROW_CAP,
    });
  }
  return queues;
}
