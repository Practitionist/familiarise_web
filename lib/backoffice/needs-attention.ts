import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  DISPUTE_RESPONSE_LEAD_MS,
  PENDING_AGE_LIMITS_MS,
} from "@/lib/cron/pending-ages";
import type { PendingAges } from "@/lib/observability/betterstack-telemetry";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import {
  DEAD_LETTER_BELL_WHERE,
  DEAD_LETTER_EMAIL_WHERE,
  PARKED_CAPTURE_WHERE,
  parkedCaptureOrder,
  parkedCaptureSince,
} from "@/lib/backoffice/queue-predicates";
import {
  DUNNABLE_ORG_STATUSES,
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
} from "@/lib/payments/billing/dunning-policy";

/** Oldest rows shown per queue, and newest rows when the queue holds more. */
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
  /** Milliseconds past the item's due point; negative while a deadline is ahead. */
  ageMs: number;
  attempts: number | null;
  lastError: string | null;
  links: AttentionLink[];
}

export interface AttentionItems {
  /** The oldest items in the queue's own order. */
  oldest: AttentionItem[];
  /** The newest items, oldest first, when the queue overflows `oldest`; disjoint from it. */
  newest: AttentionItem[];
  /** Every item in the queue, shown or not. */
  total: number;
}

export interface AttentionQueue {
  key: AttentionQueueKey;
  label: string;
  money: boolean;
  /** Ages count from a hard deadline, shown as "due in" or "overdue by". */
  deadline: boolean;
  limitMs: number;
  /** What the queue lists beyond items past the limit. */
  note?: string;
  /** Null when the read failed; the other queues still render. */
  items: AttentionItems | null;
}

interface AttentionSource {
  key: AttentionQueueKey;
  label: string;
  money: boolean;
  deadline?: true;
  note?: string;
  read: (now: Date, limitMs: number) => Promise<AttentionItems>;
}

/** An item with the value its table orders by, so windows of several tables merge. */
interface KeyedItem {
  key: number;
  item: AttentionItem;
}

/**
 * One table's oldest rows; when they overflow the cap, also its newest rows and
 * its exact count. One statement for a short queue, three for a long one.
 */
async function windowOf<R>(
  read: (order: Prisma.SortOrder, take: number) => Promise<R[]>,
  count: () => Promise<number>,
): Promise<{ rows: R[]; total: number }> {
  const oldest = await read("asc", ATTENTION_ROW_CAP + 1);
  if (oldest.length <= ATTENTION_ROW_CAP) {
    return { rows: oldest, total: oldest.length };
  }
  const [newest, total] = await Promise.all([
    read("desc", ATTENTION_ROW_CAP),
    count(),
  ]);
  return { rows: [...oldest, ...newest], total };
}

const byKeyThenId = (a: KeyedItem, b: KeyedItem): number => {
  if (a.key !== b.key) return a.key - b.key;
  if (a.item.id === b.item.id) return 0;
  return a.item.id < b.item.id ? -1 : 1;
};

/** The oldest and newest of the merged windows, deduplicated; the count is not a snapshot of the reads. */
function splitWindow(rows: KeyedItem[], total: number): AttentionItems {
  const unique = [...new Map(rows.map((r) => [r.item.id, r])).values()].sort(
    byKeyThenId,
  );
  return {
    oldest: unique.slice(0, ATTENTION_ROW_CAP).map((r) => r.item),
    newest: unique
      .slice(ATTENTION_ROW_CAP)
      .slice(-ATTENTION_ROW_CAP)
      .map((r) => r.item),
    total: Math.max(total, unique.length),
  };
}

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
      const where: Prisma.PaymentWhereInput = {
        refundOwedKey: { not: null },
        deletedAt: null,
        refundOwedAt: { lte: before(now, limitMs) },
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.payment.findMany({
            where,
            orderBy: [{ refundOwedAt: order }, { id: order }],
            take,
            select: {
              id: true,
              refundOwedAt: true,
              refundOwedAttempts: true,
              refundOwedReason: true,
            },
          }),
        () => prisma.payment.count({ where }),
      );
      return splitWindow(
        rows.map((r) => {
          const owedAt = (r.refundOwedAt ?? now).getTime();
          return {
            key: owedAt,
            item: {
              id: r.id,
              state: "Refund owed",
              ageMs: now.getTime() - owedAt,
              attempts: r.refundOwedAttempts,
              lastError: lastError(r.refundOwedReason),
              links: [
                tracePayment(r.id),
                { label: "Refunds", path: "money/refunds" },
              ],
            },
          };
        }),
        total,
      );
    },
  },
  {
    key: "parkedCaptures",
    label: "Captures parked for manual recovery",
    money: true,
    note: "A payment with a refund owed, pending or paid, or an open or lost dispute, is not listed here.",
    read: async (now) => {
      const where = PARKED_CAPTURE_WHERE;
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.payment.findMany({
            where,
            orderBy: parkedCaptureOrder(order),
            take,
            select: {
              id: true,
              appointmentId: true,
              description: true,
              capturedAt: true,
              createdAt: true,
            },
          }),
        () => prisma.payment.count({ where }),
      );
      return splitWindow(
        rows.map((p) => ({
          key: p.createdAt.getTime(),
          item: {
            id: p.id,
            state: p.appointmentId
              ? "Parked, booking exists"
              : "Parked, no booking",
            ageMs: now.getTime() - parkedCaptureSince(p).getTime(),
            attempts: null,
            lastError: lastError(p.description),
            links: [
              {
                label: "Payment",
                path: `payments/${encodeURIComponent(p.id)}`,
              },
              tracePayment(p.id),
            ],
          },
        })),
        total,
      );
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
      const consultant = await windowOf(
        (order, take) =>
          prisma.consultantPayout.findMany({
            where,
            orderBy: [{ updatedAt: order }, { id: order }],
            take,
            select: {
              id: true,
              status: true,
              updatedAt: true,
              retryCount: true,
              failureReason: true,
            },
          }),
        () => prisma.consultantPayout.count({ where }),
      );
      const org = await windowOf(
        (order, take) =>
          prisma.organizationPayout.findMany({
            where,
            orderBy: [{ updatedAt: order }, { id: order }],
            take,
            select: {
              id: true,
              status: true,
              updatedAt: true,
              failureReason: true,
            },
          }),
        () => prisma.organizationPayout.count({ where }),
      );
      return splitWindow(
        [
          ...consultant.rows.map((p) => ({
            key: p.updatedAt.getTime(),
            item: {
              id: p.id,
              state: `Expert payout ${p.status}`,
              ageMs: now.getTime() - p.updatedAt.getTime(),
              attempts: p.retryCount,
              lastError: lastError(p.failureReason),
              links: [{ label: "Payouts", path: "money/payouts" }],
            },
          })),
          ...org.rows.map((p) => ({
            key: p.updatedAt.getTime(),
            item: {
              id: p.id,
              state: `Organisation payout ${p.status}`,
              ageMs: now.getTime() - p.updatedAt.getTime(),
              attempts: null,
              lastError: lastError(p.failureReason),
              links: [{ label: "Org payouts", path: "money/org-payouts" }],
            },
          })),
        ],
        consultant.total + org.total,
      );
    },
  },
  {
    key: "dunningNotices",
    label: "Overdue invoice notices not sent",
    money: true,
    read: async (now, limitMs) => {
      const reminderDue = before(now, REMINDER_INTERVAL_MS + limitMs);
      const where: Prisma.OrganizationInvoiceWhereInput = {
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
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.organizationInvoice.findMany({
            where,
            orderBy: [{ dueDate: order }, { id: order }],
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
          }),
        () => prisma.organizationInvoice.count({ where }),
      );
      return splitWindow(
        rows.map((i) => {
          const anchor = i.lastDunningReminderAt ?? i.markedOverdueAt;
          const duePoint =
            i.status === "ISSUED" || !anchor
              ? i.dueDate.getTime()
              : anchor.getTime() + REMINDER_INTERVAL_MS;
          return {
            key: i.dueDate.getTime(),
            item: {
              id: i.id,
              state:
                i.status === "ISSUED"
                  ? `${i.invoiceNumber}: overdue notice not sent`
                  : `${i.invoiceNumber}: reminder ${i.dunningReminderCount + 1} not sent`,
              ageMs: now.getTime() - duePoint,
              attempts: i.dunningReminderCount,
              lastError: null,
              links: [{ label: "Invoices", path: "invoices" }],
            },
          };
        }),
        total,
      );
    },
  },
  {
    key: "disputesDue",
    label: "Disputes inside their response window",
    money: true,
    deadline: true,
    read: async (now) => {
      const where: Prisma.DisputeWhereInput = {
        status: { in: [...RESPONSE_DUE_DISPUTE_STATUSES] },
        dueBy: { lte: new Date(now.getTime() + DISPUTE_RESPONSE_LEAD_MS) },
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.dispute.findMany({
            where,
            orderBy: [{ dueBy: order }, { id: order }],
            take,
            select: { id: true, paymentId: true, status: true, dueBy: true },
          }),
        () => prisma.dispute.count({ where }),
      );
      // Measured from the deadline itself; only the listing opens 48 h early.
      return splitWindow(
        rows.map((d) => {
          const dueBy = (d.dueBy ?? now).getTime();
          return {
            key: dueBy,
            item: {
              id: d.id,
              state: d.status,
              ageMs: now.getTime() - dueBy,
              attempts: null,
              lastError: null,
              links: [
                tracePayment(d.paymentId),
                { label: "Disputes", path: "money/disputes" },
              ],
            },
          };
        }),
        total,
      );
    },
  },
  {
    key: "webhookEvents",
    label: "Gateway webhooks not processed",
    money: false,
    note: "Events the sweep gave up on after 7 days stay listed.",
    read: async (now, limitMs) => {
      const where: Prisma.WebhookEventWhereInput = {
        processed: false,
        receivedAt: { lte: before(now, limitMs) },
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.webhookEvent.findMany({
            where,
            orderBy: [{ receivedAt: order }, { id: order }],
            take,
            select: {
              id: true,
              eventType: true,
              receivedAt: true,
              deferCount: true,
              error: true,
            },
          }),
        () => prisma.webhookEvent.count({ where }),
      );
      return splitWindow(
        rows.map((w) => ({
          key: w.receivedAt.getTime(),
          item: {
            id: w.id,
            state: w.eventType,
            ageMs: now.getTime() - w.receivedAt.getTime(),
            attempts: w.deferCount,
            lastError: lastError(w.error),
            links: [{ label: "System jobs", path: "system-jobs" }],
          },
        })),
        total,
      );
    },
  },
  {
    key: "emailRetries",
    label: "Emails overdue or dead-lettered",
    money: false,
    note: "Dead letters are listed at any age; holds and recipient refusals are not.",
    read: async (now, limitMs) => {
      const cutoff = before(now, limitMs);
      const where: Prisma.FailedEmailWhereInput = {
        OR: [
          { status: { in: [...RETRYING] }, nextRetryAt: { lte: cutoff } },
          {
            status: { in: [...RETRYING] },
            nextRetryAt: null,
            createdAt: { lte: cutoff },
          },
          DEAD_LETTER_EMAIL_WHERE,
        ],
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.failedEmail.findMany({
            where,
            orderBy: [{ updatedAt: order }, { id: order }],
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
          }),
        () => prisma.failedEmail.count({ where }),
      );
      return splitWindow(
        rows.map((e) => ({
          key: e.updatedAt.getTime(),
          item: {
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
          },
        })),
        total,
      );
    },
  },
  {
    key: "notificationRetries",
    label: "Bell notifications overdue or dead-lettered",
    money: false,
    note: "Dead letters are listed at any age.",
    read: async (now, limitMs) => {
      const cutoff = before(now, limitMs);
      const where: Prisma.NotificationOutboxWhereInput = {
        OR: [
          { status: { in: [...RETRYING] }, nextRetryAt: { lte: cutoff } },
          {
            status: { in: [...RETRYING] },
            nextRetryAt: null,
            createdAt: { lte: cutoff },
          },
          DEAD_LETTER_BELL_WHERE,
        ],
      };
      const { rows, total } = await windowOf(
        (order, take) =>
          prisma.notificationOutbox.findMany({
            where,
            orderBy: [{ updatedAt: order }, { id: order }],
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
          }),
        () => prisma.notificationOutbox.count({ where }),
      );
      return splitWindow(
        rows.map((n) => ({
          key: n.updatedAt.getTime(),
          item: {
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
          },
        })),
        total,
      );
    },
  },
];

/**
 * The stuck items of every watched queue, read-only and in sequence for
 * `PG_POOL_MAX=1`: nine statements while each table fits the cap, two more
 * (newest rows and a count) for each table that overflows it.
 */
export async function readNeedsAttention(
  now = new Date(),
): Promise<AttentionQueue[]> {
  const queues: AttentionQueue[] = [];
  for (const source of SOURCES) {
    const limitMs = PENDING_AGE_LIMITS_MS[source.key];
    let items: AttentionItems | null;
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
      deadline: source.deadline ?? false,
      limitMs,
      note: source.note,
      items,
    });
  }
  return queues;
}
