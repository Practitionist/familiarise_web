import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { IDLE_RESULT_KEY } from "@/lib/cron/idle-skips";
import { yearsBefore } from "@/lib/cron/retention-cutoff";

const NOOP_RUN_RETENTION_DAYS = 14;
const RUN_RETENTION_DAYS = 180;
const FAILED_EMAIL_BODY_SCRUB_DAYS = 7;
const SENT_OUTBOX_RETENTION_DAYS = 30;
const DEAD_LETTER_OUTBOX_RETENTION_DAYS = 90;
const EMAIL_EVENT_RETENTION_YEARS = 1;
const ADMIN_RUN_REQUEST_RETENTION_DAYS = 30;
const DATA_EXPORT_JOB_RETENTION_YEARS = 1;
const MEETING_PRESENCE_RETENTION_DAYS = 3 * 365;
const ANONYMOUS_COOKIE_RETENTION_MONTHS = 13;
const UNCONFIRMED_NEWSLETTER_RETENTION_DAYS = 30;
const STRANDED_HOURS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORK_BUDGET_MS = 16_000;
/** Rows per run-history DELETE; a 2,000-row candidate read measured ~0.1 s on the live table. */
export const RUN_DELETE_BATCH = 1_000;
const limitSchema = z.number().int().min(1).max(500).default(100);

export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RUN_RETENTION_DAYS * DAY_MS);
}

export function noOpRunRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - NOOP_RUN_RETENTION_DAYS * DAY_MS);
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

/** DPDP Rule 8(3): delivery events are processing logs, kept a calendar year. */
export function emailEventRetentionCutoff(now: Date): Date {
  return yearsBefore(now.getTime(), EMAIL_EVENT_RETENTION_YEARS);
}

export function adminRunRequestRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - ADMIN_RUN_REQUEST_RETENTION_DAYS * DAY_MS);
}

export function dataExportJobRetentionCutoff(now: Date): Date {
  return yearsBefore(now.getTime(), DATA_EXPORT_JOB_RETENTION_YEARS);
}

export function meetingPresenceRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - MEETING_PRESENCE_RETENTION_DAYS * DAY_MS);
}

export function anonymousCookieRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - ANONYMOUS_COOKIE_RETENTION_MONTHS);
  return cutoff;
}

export function unconfirmedNewsletterRetentionCutoff(now: Date): Date {
  return new Date(
    now.getTime() - UNCONFIRMED_NEWSLETTER_RETENTION_DAYS * DAY_MS,
  );
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

export interface SecondaryRetentionPruneResult {
  dataExportJobsPruned: number;
  cookiePreferencesPruned: number;
  unconfirmedNewsletterPruned: number;
  meetingPresencePruned: number;
  meetingAttendancePruned: number;
  streamRevocationRetriesPruned: number;
  hasMore: boolean;
}

export interface SystemJobExecutionPruneResult
  extends MessagingRetentionPruneResult, SecondaryRetentionPruneResult {
  success: boolean;
  /** Run rows deleted by both tiers. */
  pruned: number;
  noOpRunsPruned: number;
  stranded: number;
  adminRunRequestsPruned: number;
  retentionCutoff: string;
  noOpRetentionCutoff: string;
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

/** Export jobs, anonymous cookie choices, unconfirmed sign-ups, meeting presence and settled revocation rows; one bounded page each. */
async function pruneSecondaryRetentionPages(
  now: Date,
  limit: number,
  deadline: number,
): Promise<SecondaryRetentionPruneResult> {
  const exportWhere: Prisma.OrgDataExportJobWhereInput = {
    status: { in: ["READY", "FAILED", "EXPIRED"] },
    createdAt: { lt: dataExportJobRetentionCutoff(now) },
  };
  const cookieWhere: Prisma.CookiePreferenceWhereInput = {
    userId: null,
    consentUpdatedAt: { lt: anonymousCookieRetentionCutoff(now) },
  };
  // A sign-up never confirmed carries no consent; a re-signup restarts the window.
  const unconfirmedCutoff = unconfirmedNewsletterRetentionCutoff(now);
  const unconfirmedWhere: Prisma.NewsletterSubscriberWhereInput = {
    status: "PENDING",
    createdAt: { lt: unconfirmedCutoff },
    updatedAt: { lt: unconfirmedCutoff },
  };
  const occurrenceEnded = {
    occurrence: { endsAt: { lt: meetingPresenceRetentionCutoff(now) } },
  };
  // Erasure rows stay with their request; an owed row is never a candidate.
  const settledRevocationWhere: Prisma.StreamRevocationRetryWhereInput = {
    erasureRequestId: null,
    status: "SUCCEEDED",
    completedAt: { lt: sentOutboxRetentionCutoff(now) },
  };
  const exportJobs = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.orgDataExportJob.findMany({
        where: exportWhere,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.orgDataExportJob.deleteMany({
        where: { ...exportWhere, id: { in: ids } },
      }),
  );
  const cookies = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.cookiePreference.findMany({
        where: cookieWhere,
        select: { id: true },
        orderBy: [{ consentUpdatedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.cookiePreference.deleteMany({
        where: { ...cookieWhere, id: { in: ids } },
      }),
  );
  const unconfirmed = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.newsletterSubscriber.findMany({
        where: unconfirmedWhere,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.newsletterSubscriber.deleteMany({
        where: { ...unconfirmedWhere, id: { in: ids } },
      }),
  );
  const presence = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.meetingPresence.findMany({
        where: occurrenceEnded,
        select: { id: true },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.meetingPresence.deleteMany({
        where: { ...occurrenceEnded, id: { in: ids } },
      }),
  );
  const attendance = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.meetingAttendance.findMany({
        where: occurrenceEnded,
        select: { id: true },
        orderBy: [{ firstJoinedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.meetingAttendance.deleteMany({
        where: { ...occurrenceEnded, id: { in: ids } },
      }),
  );
  const revocations = await mutateRetentionPage(
    limit,
    deadline,
    (take) =>
      prisma.streamRevocationRetry.findMany({
        where: settledRevocationWhere,
        select: { id: true },
        orderBy: [{ completedAt: "asc" }, { id: "asc" }],
        take,
      }),
    (ids) =>
      prisma.streamRevocationRetry.deleteMany({
        where: { ...settledRevocationWhere, id: { in: ids } },
      }),
  );
  return {
    dataExportJobsPruned: exportJobs.count,
    cookiePreferencesPruned: cookies.count,
    unconfirmedNewsletterPruned: unconfirmed.count,
    meetingPresencePruned: presence.count,
    meetingAttendancePruned: attendance.count,
    streamRevocationRetriesPruned: revocations.count,
    hasMore: [
      exportJobs,
      cookies,
      unconfirmed,
      presence,
      attendance,
      revocations,
    ].some((p) => p.hasMore),
  };
}

/**
 * A no-op run: completed with no items, errors, checkpoint or idle skips, by
 * the ticker rather than an admin, and not its job's newest completed run.
 */
function noOpRunBatch(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM "SystemJobExecution" WHERE "id" IN (
      SELECT s."id" FROM "SystemJobExecution" s
      WHERE s."status" = 'COMPLETED' AND s."startedAt" < ${cutoff}
        AND COALESCE(s."itemsProcessed", 0) = 0
        AND COALESCE(s."errorCount", 0) = 0
        AND s."errorLog" IS NULL
        AND COALESCE(s."triggeredBy", '') NOT LIKE 'admin:%'
        AND NOT COALESCE(jsonb_exists(s."result", 'checkpoint'), false)
        AND COALESCE(jsonb_array_length(CASE
          WHEN jsonb_typeof(s."result"->(${IDLE_RESULT_KEY}::text)) = 'array'
          THEN s."result"->(${IDLE_RESULT_KEY}::text) END), 0) = 0
        AND EXISTS (
          SELECT 1 FROM "SystemJobExecution" n
          WHERE n."jobName" = s."jobName" AND n."status" = 'COMPLETED'
            AND n."startedAt" > s."startedAt")
      ORDER BY s."startedAt" LIMIT ${RUN_DELETE_BATCH})`;
}

function agedRunBatch(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM "SystemJobExecution" WHERE "id" IN (
      SELECT "id" FROM "SystemJobExecution"
      WHERE "status" <> 'RUNNING' AND "startedAt" < ${cutoff}
      ORDER BY "startedAt" LIMIT ${RUN_DELETE_BATCH})`;
}

/** Whole batches until one comes back short or the deadline passes; each DELETE re-evaluates its own predicate. */
async function drainRunBatches(
  batch: Prisma.Sql,
  deadline: number,
): Promise<{ count: number; hasMore: boolean }> {
  let count = 0;
  while (Date.now() < deadline) {
    const deleted = await prisma.$executeRaw(batch);
    count += deleted;
    if (deleted < RUN_DELETE_BATCH) return { count, hasMore: false };
  }
  return { count, hasMore: true };
}

/** Bounded pages first, then run-history batches until the shared deadline; an interrupted run resumes from remaining eligible rows. */
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
      const noOpRetention = noOpRunRetentionCutoff(now);
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
      const secondary = await pruneSecondaryRetentionPages(
        now,
        limit,
        deadline,
      );
      const noOp = await drainRunBatches(noOpRunBatch(noOpRetention), deadline);
      const aged = noOp.hasMore
        ? { count: 0, hasMore: true }
        : await drainRunBatches(agedRunBatch(retention), deadline);
      return {
        ...messaging,
        ...secondary,
        success: true,
        pruned: noOp.count + aged.count,
        noOpRunsPruned: noOp.count,
        stranded: closed.count,
        adminRunRequestsPruned: requests.count,
        retentionCutoff: retention.toISOString(),
        noOpRetentionCutoff: noOpRetention.toISOString(),
        strandedCutoff: stranded.toISOString(),
        hasMore:
          closed.hasMore ||
          requests.hasMore ||
          messaging.hasMore ||
          secondary.hasMore ||
          noOp.hasMore ||
          aged.hasMore,
      };
    },
  );
}
