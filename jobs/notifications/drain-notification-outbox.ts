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

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";

const MAX_BATCH = 50;

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
  };
}

/** Single-tick worker; `now` and the store are injectable for the unit pins. */
export async function runNotificationDrainTick(params: {
  prisma: NotificationOutboxStore;
  now?: () => number;
  maxBatch?: number;
  /** Injectable attempt so the drain's own logic can be pinned without Novu. */
  attempt?: typeof attemptTrigger;
}): Promise<NotificationDrainResult> {
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

  const dueRows = await params.prisma.notificationOutbox.findMany({
    where: {
      AND: [
        {
          OR: [
            { status: "PENDING" },
            { status: "RETRY", nextRetryAt: { lte: nowDate } },
          ],
        },
        // A zoned or quiet-hours deferral: the row waits until its instant.
        { OR: [{ notBefore: null }, { notBefore: { lte: nowDate } }] },
      ],
    },
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
    },
  });

  for (const row of dueRows) {
    result.scanned += 1;
    const outcome = await attempt(row, { relay: true, now });
    if (outcome.outcome === "SENT") result.sent += 1;
    else if (outcome.outcome === "DEAD_LETTER") result.deadLettered += 1;
    else if (outcome.outcome === "RETRY") result.retried += 1;
    else if (outcome.error) {
      // PENDING with no row change: Novu is not configured, so stop early —
      // every later row would answer the same way.
      result.errors.push(String(outcome.error));
      break;
    }
  }

  return result;
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
  runJob("drain-notification-outbox", async () => {
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
