/**
 * #1654 — the Novu outbox relay (closes #691 NTF-1).
 *
 * Drains `NotificationOutbox` rows that lib/novu/outbox.ts staged before the
 * inline trigger attempt (status PENDING when that attempt timed out, failed
 * transiently or never ran; RETRY on any later scheduled attempt), whose
 * `nextRetryAt` is now or earlier and whose `notBefore` has passed. One tick
 * takes up to `MAX_BATCH` rows and re-triggers each through the same wire path
 * the inline attempt used, under the same `transactionId`, so a row the inline
 * path sent but could not mark is deduplicated by Novu instead of rung twice.
 * Outcomes: SENT; RETRY on the shared backoff ladder (lib/retry/backoff.ts);
 * DEAD_LETTER after MAX_ATTEMPTS or on a terminal 4xx. The table is the queue
 * (ADR 27), as for FailedEmail and OutboundWebhookDelivery.
 */

import prisma, { type PrismaLike } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";
import { postOpsChat } from "@/lib/observability/ops-chat";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";

const MAX_BATCH = 50;
export const DRAIN_CONCURRENCY = 5;

export interface NotificationDrainResult {
  scanned: number;
  sent: number;
  retried: number;
  deadLettered: number;
  errors: string[];
}

/** The slice of the client this worker reads; the attempt writes through lib/novu/outbox.ts. */
export interface NotificationOutboxStore {
  notificationOutbox: {
    findMany(
      args: Prisma.NotificationOutboxFindManyArgs,
    ): Promise<StagedTrigger[]>;
    count?(args?: Prisma.NotificationOutboxCountArgs): Promise<number>;
  };
}

/** Rows due a trigger at `now`; shared by the relay and the ticker's idle probe. */
function outboxDueWhere(now: Date): Prisma.NotificationOutboxWhereInput {
  return {
    AND: [
      {
        OR: [
          {
            status: "PENDING",
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          { status: "RETRY", nextRetryAt: { lte: now } },
        ],
      },
      { OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
    ],
  };
}

/** Ticker idle probe; a skipped tick leaves the outbox gauges at their last value. */
export async function hasNotificationOutboxWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.notificationOutbox.findFirst({
    where: outboxDueWhere(now),
    select: { id: true },
  });
  return row !== null;
}

/** Single-tick worker; `now` and the store are injectable for the unit pins. */
export async function runNotificationDrainTick(params: {
  prisma: NotificationOutboxStore;
  now?: () => number;
  maxBatch?: number;
  /** Injectable attempt so the drain's own logic can be pinned without Novu. */
  attempt?: typeof attemptTrigger;
}): Promise<NotificationDrainResult> {
  const runBody = async (
    span?: Sentry.Span,
  ): Promise<NotificationDrainResult> => {
    const now = params.now ?? (() => Date.now());
    const attempt = params.attempt ?? attemptTrigger;
    const nowDate = new Date(now());
    const result: NotificationDrainResult = {
      scanned: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
      errors: [],
    };
    const tickFailures: Array<{
      id: string;
      workflowId: string;
      outcome: string;
      error?: string;
    }> = [];

    const dueRows = await params.prisma.notificationOutbox.findMany({
      where: outboxDueWhere(nowDate),
      orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
      take: params.maxBatch ?? MAX_BATCH,
      select: {
        id: true,
        workflowId: true,
        kind: true,
        recipients: true,
        payload: true,
        transactionId: true,
        attempts: true,
        status: true,
        createdAt: true,
      },
    });

    const recordOutcome = (
      row: StagedTrigger,
      outcome: Awaited<ReturnType<typeof attemptTrigger>>,
    ): boolean => {
      result.scanned += 1;
      if (row.createdAt) {
        const lagSeconds = Math.max(
          0,
          (nowDate.getTime() - new Date(row.createdAt).getTime()) / 1000,
        );
        Sentry.metrics?.distribution?.(
          "notifications.outbox.lag_seconds",
          lagSeconds,
        );
      }
      if (outcome.outcome === "SENT") {
        result.sent += 1;
      } else if (outcome.outcome === "DEAD_LETTER") {
        result.deadLettered += 1;
        tickFailures.push({
          id: row.id,
          workflowId: row.workflowId,
          outcome: "DEAD_LETTER",
          ...(outcome.error ? { error: String(outcome.error) } : {}),
        });
      } else if (outcome.outcome === "RETRY") {
        result.retried += 1;
        tickFailures.push({
          id: row.id,
          workflowId: row.workflowId,
          outcome: "RETRY",
          ...(outcome.error ? { error: String(outcome.error) } : {}),
        });
      } else if (outcome.error) {
        result.errors.push(String(outcome.error));
        return false;
      }
      return true;
    };

    if (dueRows.length > 0) {
      const firstRow = dueRows[0];
      const firstOutcome = await attempt(firstRow, {
        relay: true,
        now,
        suppressSentry: true,
      });
      if (recordOutcome(firstRow, firstOutcome)) {
        const rest = dueRows.slice(1);
        for (let i = 0; i < rest.length; i += DRAIN_CONCURRENCY) {
          const chunk = rest.slice(i, i + DRAIN_CONCURRENCY);
          const outcomes = await Promise.all(
            chunk.map((row) =>
              attempt(row, { relay: true, now, suppressSentry: true }),
            ),
          );
          let shouldContinue = true;
          for (let j = 0; j < chunk.length; j += 1) {
            if (!recordOutcome(chunk[j], outcomes[j])) {
              shouldContinue = false;
              break;
            }
          }
          if (!shouldContinue) break;
        }
      }
    }

    if (tickFailures.length > 0) {
      Sentry.captureException(
        new Error(
          `Notification outbox drain encountered ${tickFailures.length} failure(s) (${result.deadLettered} dead-lettered, ${result.retried} retried)`,
        ),
        {
          level: result.deadLettered > 0 ? "error" : "warning",
          tags: {
            subsystem: "novu",
            op: "drain-outbox",
            ...(result.deadLettered > 0 ? { outbox_dead_letter: "true" } : {}),
          },
          extra: {
            scanned: result.scanned,
            retried: result.retried,
            deadLettered: result.deadLettered,
            failures: tickFailures.slice(0, 10),
          },
        },
      );
    }

    span?.setAttributes?.({
      "outbox.scanned": result.scanned,
      "outbox.sent": result.sent,
      "outbox.retried": result.retried,
      "outbox.dead_lettered": result.deadLettered,
    });

    Sentry.metrics?.count?.("notifications.outbox.drained", result.sent);
    Sentry.metrics?.count?.("notifications.outbox.retried", result.retried);
    Sentry.metrics?.count?.(
      "notifications.outbox.dead_lettered",
      result.deadLettered,
    );

    if (typeof params.prisma.notificationOutbox.count === "function") {
      try {
        const [pendingCount, deadLetterCount] = await Promise.all([
          params.prisma.notificationOutbox.count({
            where: { status: { in: ["PENDING", "RETRY"] } },
          }),
          params.prisma.notificationOutbox.count({
            where: { status: "DEAD_LETTER" },
          }),
        ]);
        Sentry.metrics?.gauge?.("notifications.outbox.pending", pendingCount);
        Sentry.metrics?.gauge?.(
          "notifications.outbox.dead_letter",
          deadLetterCount,
        );
      } catch {
        // Best-effort metric gauge; never fail the drain tick.
      }
    }

    if (result.deadLettered > 0) {
      const deadLetterWorkflows = [
        ...new Set(
          tickFailures
            .filter((f) => f.outcome === "DEAD_LETTER")
            .map((f) => f.workflowId),
        ),
      ].join(", ");
      await postOpsChat(
        `:rotating_light: Notification outbox dead-lettered ${result.deadLettered} row(s) (${deadLetterWorkflows || "unknown"})`,
      );
    }

    return result;
  };

  if (typeof Sentry.startSpan === "function") {
    return Sentry.startSpan(
      { name: "notifications.outbox.drain", op: "queue.process" },
      runBody,
    );
  }
  return runBody(undefined);
}

// Fail-closed like the email relay (#1230): a held or unavailable lock pages
// rather than letting two replicas trigger every row twice; Novu's dedupe on
// transactionId is the backstop, not the design.
export async function drainNotificationOutbox(opts?: {
  limit?: number;
}): Promise<NotificationDrainResult> {
  return withCronLock("drain-notification-outbox", { failMode: "closed" }, () =>
    runNotificationDrainTick({ prisma, maxBatch: opts?.limit }),
  );
}

if (require.main === module) {
  runJob("drain-notification-outbox", async () => {
    // Loaded here (not at module top) so importing this file from Next/tests never
    // reads .env; dynamic import is the ESM form of the old lazy require.
    await import("dotenv/config");
    await abortIfMaintenance("drain-notification-outbox");
    Sentry.logger.info("job:drain-notification-outbox started");
    try {
      const result = await drainNotificationOutbox();
      console.log(JSON.stringify(result, null, 2));
      Sentry.logger.info("job:drain-notification-outbox finished", {
        scanned: result.scanned,
        sent: result.sent,
        retried: result.retried,
        deadLettered: result.deadLettered,
        errors: result.errors.length,
      });
      if (result.errors.length > 0) process.exitCode = 1;
    } catch (err) {
      if (!(err instanceof CronLockHeldError)) {
        await recordSystemError({
          category: "NOTIFICATION",
          summary: "Notification outbox drain crashed",
          err,
        });
      }
      throw err;
    } finally {
      await prisma.$disconnect();
    }
  });
}
