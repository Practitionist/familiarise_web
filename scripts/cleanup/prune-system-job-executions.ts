import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const RETENTION_DAYS = 90;
const FAILED_EMAIL_BODY_SCRUB_DAYS = 7;
const SENT_OUTBOX_RETENTION_DAYS = 30;
const DEAD_LETTER_OUTBOX_RETENTION_DAYS = 90;
const EMAIL_EVENT_RETENTION_DAYS = 30;
const ADMIN_RUN_REQUEST_RETENTION_DAYS = 30;
const STRANDED_HOURS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORK_BUDGET_MS = 16_000;
const limitSchema = z.number().int().min(1).max(500).default(100);

export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
}

/** The lease heartbeat updates startedAt; an old value signals missing renewals. */
export function strandedCutoff(now: Date): Date {
  return new Date(now.getTime() - STRANDED_HOURS * 60 * 60 * 1000);
}

export function failedEmailBodyScrubCutoff(now: Date): Date {
  return new Date(now.getTime() - FAILED_EMAIL_BODY_SCRUB_DAYS * DAY_MS);
}

export function sentOutboxRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - SENT_OUTBOX_RETENTION_DAYS * DAY_MS);
}

export function deadLetterOutboxRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DEAD_LETTER_OUTBOX_RETENTION_DAYS * DAY_MS);
}

export function emailEventRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - EMAIL_EVENT_RETENTION_DAYS * DAY_MS);
}

export function adminRunRequestRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - ADMIN_RUN_REQUEST_RETENTION_DAYS * DAY_MS);
}

export const STRANDED_ERROR = "stranded (no heartbeat)";

export interface MessagingRetentionPruneResult {
  failedEmailsBodyScrubbed: number;
  failedEmailBatchesScrubbed: number;
  failedEmailsPruned: number;
  failedEmailBatchesPruned: number;
  notificationOutboxPruned: number;
  emailEventsPruned: number;
  hasMore: boolean;
}

export interface SystemJobExecutionPruneResult extends MessagingRetentionPruneResult {
  success: boolean;
  pruned: number;
  stranded: number;
  adminRunRequestsPruned: number;
  retentionCutoff: string;
  strandedCutoff: string;
}

/** One page per phase; the writer must recheck eligibility as well as selected IDs. */
async function mutateRetentionPage(
  limit: number,
  deadline: number,
  find: (take: number) => Promise<{ id: string }[]>,
  mutate: (ids: string[]) => Promise<{ count: number }>,
): Promise<{ count: number; hasMore: boolean }> {
  if (Date.now() >= deadline) return { count: 0, hasMore: true };
  const rows = await find(limit + 1);
  if (Date.now() >= deadline) return { count: 0, hasMore: rows.length > 0 };
  const ids = rows.slice(0, limit).map((row) => row.id);
  const count = ids.length > 0 ? (await mutate(ids)).count : 0;
  return { count, hasMore: rows.length > limit };
}

/** Six independent, bounded pages; active obligations are never retention candidates. */
export async function pruneMessagingRetentionTables(
  now: Date = new Date(),
  opts: { limit?: number } = {},
): Promise<MessagingRetentionPruneResult> {
  const limit = limitSchema.parse(opts.limit);
  return pruneMessagingRetentionPages(now, limit, Date.now() + WORK_BUDGET_MS);
}

async function pruneMessagingRetentionPages(
  now: Date,
  limit: number,
  deadline: number,
): Promise<MessagingRetentionPruneResult> {
  const scrubBefore = failedEmailBodyScrubCutoff(now);
  const sentBefore = sentOutboxRetentionCutoff(now);
  const deadLetterBefore = deadLetterOutboxRetentionCutoff(now);
  const emailEventBefore = emailEventRetentionCutoff(now);

  const scrubEmailWhere: Prisma.FailedEmailWhereInput = {
    status: "SENT",
    AND: [
      {
        OR: [
          { sentAt: { lt: scrubBefore } },
          { sentAt: null, updatedAt: { lt: scrubBefore } },
        ],
      },
      { OR: [{ htmlBody: { not: "" } }, { textBody: { not: null } }] },
    ],
  };
  const scrubEmailBatchWhere: Prisma.FailedEmailBatchWhereInput = {
    status: "SENT",
    OR: [
      { sentAt: { lt: scrubBefore } },
      { sentAt: null, updatedAt: { lt: scrubBefore } },
    ],
    payload: { not: [] },
  };
  const expiredEmailWhere: Prisma.FailedEmailWhereInput = {
    OR: [
      { status: "SENT", sentAt: { lt: sentBefore } },
      { status: "SENT", sentAt: null, updatedAt: { lt: sentBefore } },
      { status: "DEAD_LETTER", updatedAt: { lt: deadLetterBefore } },
    ],
  };
  const expiredEmailBatchWhere: Prisma.FailedEmailBatchWhereInput = {
    OR: [
      { status: "SENT", sentAt: { lt: sentBefore } },
      { status: "SENT", sentAt: null, updatedAt: { lt: sentBefore } },
      { status: "DEAD_LETTER", updatedAt: { lt: deadLetterBefore } },
    ],
  };
  const expiredNotificationWhere: Prisma.NotificationOutboxWhereInput = {
    OR: [
      { status: "SENT", updatedAt: { lt: sentBefore } },
      { status: "DEAD_LETTER", updatedAt: { lt: deadLetterBefore } },
    ],
  };

  const emailScrub = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.failedEmail.findMany({
        where: scrubEmailWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    async (ids) => ({
      // Preserve the retention clock on legacy rows without sentAt.
      count: await prisma.$executeRaw(Prisma.sql`
        UPDATE "FailedEmail" SET "htmlBody" = '', "textBody" = NULL
        WHERE "id" IN (${Prisma.join(ids)}) AND "status" = 'SENT'
          AND COALESCE("sentAt", "updatedAt") < ${scrubBefore}
          AND ("htmlBody" <> '' OR "textBody" IS NOT NULL)
      `),
    }),
  );
  const batchScrub = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.failedEmailBatch.findMany({
        where: scrubEmailBatchWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    async (ids) => ({
      count: await prisma.$executeRaw(Prisma.sql`
        UPDATE "FailedEmailBatch" SET "payload" = '[]'::jsonb
        WHERE "id" IN (${Prisma.join(ids)}) AND "status" = 'SENT'
          AND COALESCE("sentAt", "updatedAt") < ${scrubBefore}
          AND "payload" <> '[]'::jsonb
      `),
    }),
  );
  const emailDelete = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.failedEmail.findMany({
        where: expiredEmailWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.failedEmail.deleteMany({
        where: { AND: [expiredEmailWhere, { id: { in: ids } }] },
      }),
  );
  const batchDelete = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.failedEmailBatch.findMany({
        where: expiredEmailBatchWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.failedEmailBatch.deleteMany({
        where: { AND: [expiredEmailBatchWhere, { id: { in: ids } }] },
      }),
  );
  const notificationDelete = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.notificationOutbox.findMany({
        where: expiredNotificationWhere,
        select: { id: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.notificationOutbox.deleteMany({
        where: { AND: [expiredNotificationWhere, { id: { in: ids } }] },
      }),
  );
  const eventDelete = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.emailEvent.findMany({
        where: { receivedAt: { lt: emailEventBefore } },
        select: { id: true },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.emailEvent.deleteMany({
        where: { id: { in: ids }, receivedAt: { lt: emailEventBefore } },
      }),
  );

  return {
    failedEmailsBodyScrubbed: emailScrub.count,
    failedEmailBatchesScrubbed: batchScrub.count,
    failedEmailsPruned: emailDelete.count,
    failedEmailBatchesPruned: batchDelete.count,
    notificationOutboxPruned: notificationDelete.count,
    emailEventsPruned: eventDelete.count,
    hasMore: [
      emailScrub,
      batchScrub,
      emailDelete,
      batchDelete,
      notificationDelete,
      eventDelete,
    ].some((phase) => phase.hasMore),
  };
}

/** Nine pages in total; an interrupted run resumes from remaining eligible rows. */
export async function pruneSystemJobExecutions(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<SystemJobExecutionPruneResult> {
  const limit = limitSchema.parse(opts.limit);
  const deadline = (opts.startedAt ?? Date.now()) + WORK_BUDGET_MS;
  return withCronLock(
    "prune-system-job-executions",
    { failMode: "closed" },
    async () => {
      const now = new Date();
      const retention = retentionCutoff(now);
      const stranded = strandedCutoff(now);
      const closed = await mutateRetentionPage(
        limit,
        deadline,
        (take) =>
          prisma.systemJobExecution.findMany({
            where: { status: "RUNNING", startedAt: { lt: stranded } },
            select: { id: true },
            orderBy: [{ startedAt: "asc" }, { id: "asc" }],
            take,
          }),
        (ids) =>
          prisma.systemJobExecution.updateMany({
            where: {
              id: { in: ids },
              status: "RUNNING",
              startedAt: { lt: stranded },
            },
            data: { status: "FAILED", endedAt: now, errorLog: STRANDED_ERROR },
          }),
      );
      const deleted = await mutateRetentionPage(
        limit,
        deadline,
        (take) =>
          prisma.systemJobExecution.findMany({
            where: { status: { not: "RUNNING" }, startedAt: { lt: retention } },
            select: { id: true },
            orderBy: [{ startedAt: "asc" }, { id: "asc" }],
            take,
          }),
        (ids) =>
          prisma.systemJobExecution.deleteMany({
            where: {
              id: { in: ids },
              status: { not: "RUNNING" },
              startedAt: { lt: retention },
            },
          }),
      );
      const settledBefore = adminRunRequestRetentionCutoff(now);
      const settledRequestWhere: Prisma.AdminRunRequestWhereInput = {
        status: { in: ["DONE", "FAILED"] },
        finishedAt: { lt: settledBefore },
      };
      const requests = await mutateRetentionPage(
        limit,
        deadline,
        (take) =>
          prisma.adminRunRequest.findMany({
            where: settledRequestWhere,
            select: { id: true },
            orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
            take,
          }),
        (ids) =>
          prisma.adminRunRequest.deleteMany({
            where: { AND: [settledRequestWhere, { id: { in: ids } }] },
          }),
      );
      const messaging = await pruneMessagingRetentionPages(
        now,
        limit,
        deadline,
      );
      return {
        ...messaging,
        success: true,
        pruned: deleted.count,
        stranded: closed.count,
        adminRunRequestsPruned: requests.count,
        retentionCutoff: retention.toISOString(),
        strandedCutoff: stranded.toISOString(),
        hasMore:
          closed.hasMore ||
          deleted.hasMore ||
          requests.hasMore ||
          messaging.hasMore,
      };
    },
  );
}
