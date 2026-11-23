import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Tx } from "@/lib/prisma";
import {
  PARKED_CAPTURE_WHERE,
  parkedCaptureOrder,
  parkedCaptureSince,
} from "@/lib/backoffice/queue-predicates";
import {
  pendingAgesSchema,
  type PendingAges,
} from "@/lib/observability/betterstack-telemetry";
import {
  DUNNABLE_ORG_STATUSES,
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
} from "@/lib/payments/billing/dunning-policy";

const HOUR_MS = 60 * 60 * 1000;

/** Alert and inbox limit per gauge, past its due point; the cadence behind each is in the Better Stack setup doc. */
export const PENDING_AGE_LIMITS_MS: Readonly<
  Record<keyof PendingAges, number>
> = {
  refundsOwed: HOUR_MS,
  payoutsStuck: 4 * HOUR_MS,
  dunningNotices: 26 * HOUR_MS,
  disputesDue: 0,
  webhookEvents: HOUR_MS,
  emailRetries: HOUR_MS,
  notificationRetries: HOUR_MS,
  // No sweep clears a parked capture, so every one is past due.
  parkedCaptures: 0,
};

/** A dispute is due for attention this long before its evidence deadline. */
export const DISPUTE_RESPONSE_LEAD_MS = 48 * HOUR_MS;

/** The stuck-webhook sweep stops re-driving an event after this; older unprocessed rows are given up. */
export const WEBHOOK_GIVE_UP_MS = 168 * HOUR_MS;

const ageOf = (oldestDuePoint: Prisma.Sql, now: Date) =>
  Prisma.sql`GREATEST(0, COALESCE(EXTRACT(EPOCH FROM ${now}::timestamptz - (${oldestDuePoint})), 0))::int`;

const sqlGaugesSchema = pendingAgesSchema.omit({ parkedCaptures: true });

/**
 * Every watched queue's oldest-pending age, 0 when nothing is past its due point:
 * one statement, then the parked-capture queue's first row through the page's own
 * `where`. `OrganizationInvoice` and `WebhookEvent` keep UTC `timestamp` columns,
 * read `AT TIME ZONE 'UTC'`. With `outOfTime`, the second statement starts only
 * while it is false, and the result is null otherwise.
 */
export async function readPendingAges(tx: Tx, now: Date): Promise<PendingAges>;
export async function readPendingAges(
  tx: Tx,
  now: Date,
  outOfTime: () => boolean,
): Promise<PendingAges | null>;
export async function readPendingAges(
  tx: Tx,
  now: Date,
  outOfTime: () => boolean = () => false,
): Promise<PendingAges | null> {
  const dunnable = Prisma.join([...DUNNABLE_ORG_STATUSES]);
  const reminderSecs = REMINDER_INTERVAL_MS / 1000;
  const rows = await tx.$queryRaw(Prisma.sql`
    SELECT
      ${ageOf(
        Prisma.sql`SELECT min("refundOwedAt") FROM "Payment"
          WHERE "refundOwedKey" IS NOT NULL AND "deletedAt" IS NULL`,
        now,
      )} AS "refundsOwed",
      ${ageOf(
        Prisma.sql`SELECT min(u) FROM (
          SELECT min("updatedAt") AS u FROM "ConsultantPayout"
            WHERE status IN ('APPROVED', 'PROCESSING')
          UNION ALL
          SELECT min("updatedAt") FROM "OrganizationPayout"
            WHERE status IN ('APPROVED', 'PROCESSING')) p`,
        now,
      )} AS "payoutsStuck",
      ${ageOf(
        Prisma.sql`SELECT min(due) FROM (
          SELECT i."dueDate" AT TIME ZONE 'UTC' AS due FROM "OrganizationInvoice" i
            JOIN "organizations" o ON o.id = i."organizationId"
            WHERE i.status = 'ISSUED' AND i."markedOverdueAt" IS NULL
              AND o.status::text IN (${dunnable})
          UNION ALL
          SELECT COALESCE(i."lastDunningReminderAt", i."markedOverdueAt") AT TIME ZONE 'UTC'
              + make_interval(secs => ${reminderSecs})
            FROM "OrganizationInvoice" i
            JOIN "organizations" o ON o.id = i."organizationId"
            WHERE i.status = 'OVERDUE' AND i."dunningReminderCount" < ${MAX_REMINDERS}
              AND o.status::text IN (${dunnable})) d
          WHERE due < ${now}::timestamptz`,
        now,
      )} AS "dunningNotices",
      ${ageOf(
        Prisma.sql`SELECT min("dueBy") - make_interval(secs => ${DISPUTE_RESPONSE_LEAD_MS / 1000})
          FROM "Dispute"
          WHERE status IN ('WARNING_NEEDS_RESPONSE', 'NEEDS_RESPONSE')`,
        now,
      )} AS "disputesDue",
      ${ageOf(
        Prisma.sql`SELECT min("receivedAt" AT TIME ZONE 'UTC') FROM "WebhookEvent"
          WHERE processed = false
            AND "receivedAt" AT TIME ZONE 'UTC'
              >= ${new Date(now.getTime() - WEBHOOK_GIVE_UP_MS)}::timestamptz`,
        now,
      )} AS "webhookEvents",
      ${ageOf(
        Prisma.sql`SELECT min(COALESCE("nextRetryAt", "createdAt")) FROM "FailedEmail"
          WHERE status IN ('PENDING', 'RETRY')`,
        now,
      )} AS "emailRetries",
      ${ageOf(
        Prisma.sql`SELECT min(GREATEST(COALESCE("nextRetryAt", "createdAt"),
            COALESCE("notBefore", "createdAt")))
          FROM "NotificationOutbox"
          WHERE status IN ('PENDING', 'RETRY')`,
        now,
      )} AS "notificationRetries"
  `);
  const [ages] = z.tuple([sqlGaugesSchema]).parse(rows);
  if (outOfTime()) return null;
  const parked = await tx.payment.findFirst({
    where: PARKED_CAPTURE_WHERE,
    orderBy: parkedCaptureOrder("asc"),
    select: { capturedAt: true, createdAt: true },
  });
  return {
    ...ages,
    parkedCaptures: parked
      ? Math.max(
          0,
          Math.round(
            (now.getTime() - parkedCaptureSince(parked).getTime()) / 1000,
          ),
        )
      : 0,
  };
}
