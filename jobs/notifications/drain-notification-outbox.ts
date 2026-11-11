/**
 * #1654 — the Novu outbox relay (closes #691 NTF-1).
 *
 * Drains `NotificationOutbox` rows that lib/novu/outbox.ts staged before the
 * inline trigger attempt (status PENDING when that attempt timed out, failed
 * transiently or never ran; RETRY on any later scheduled attempt), whose
 * `nextRetryAt` is now or earlier and whose `notBefore` has passed. One tick
 * takes up to `MAX_BATCH` rows, urgent workflows first, and re-triggers each
 * through the same wire path the inline attempt used, with the same frozen
 * recipients and Idempotency-Key, so a row the inline path sent but could not
 * mark is deduplicated by Novu instead of rung twice.
 * Outcomes: SENT; RETRY on the shared backoff ladder (lib/retry/backoff.ts);
 * DEAD_LETTER after MAX_ATTEMPTS or on a terminal 4xx. The table is the queue
 * (ADR 27), as for FailedEmail and OutboundWebhookDelivery.
 */

import prisma, { type PrismaLike } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { postOpsChat } from "@/lib/observability/ops-chat";
import {
  DEAD_LETTER_BELL_WHERE,
  isExpectedBellDeadLetter,
} from "@/lib/backoffice/queue-predicates";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

const MAX_BATCH = 100;
export const DRAIN_CONCURRENCY = 5;
/**
 * No new wave starts past this. An attempt makes at most one bulk call (5 s
 * timeout plus at most 5 s of SDK retries), so the last wave ends inside the
 * 24 s target timeout.
 */
const WAVE_START_BUDGET_MS = 12_000;

/** Security and money-failure bells drain ahead of routine ones. */
export const URGENT_WORKFLOWS: readonly string[] = [
  NOVU_WORKFLOWS.ACCOUNT_SECURITY_NOTICE,
  NOVU_WORKFLOWS.ACCOUNT_SUSPENDED,
  NOVU_WORKFLOWS.ACCOUNT_BANNED,
  NOVU_WORKFLOWS.PAYMENT_FAILED,
  NOVU_WORKFLOWS.REFUND_FAILED,
  NOVU_WORKFLOWS.PAYOUT_FAILED,
  NOVU_WORKFLOWS.ORG_PAYOUT_FAILED,
  NOVU_WORKFLOWS.DISPUTE_CREATED,
  NOVU_WORKFLOWS.COMPLIANCE_DEADLINE_ALERT,
];

const DUE_ROW_SELECT = {
  id: true,
  workflowId: true,
  kind: true,
  recipients: true,
  payload: true,
  transactionId: true,
  attempts: true,
  status: true,
  notBefore: true,
  firstAttemptAt: true,
  entityRef: true,
  lastError: true,
  createdAt: true,
} as const;

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

    const limit = params.maxBatch ?? MAX_BATCH;
    const dueBatch = (
      workflowId: Prisma.StringFilter<"NotificationOutbox">,
      take: number,
    ) =>
      params.prisma.notificationOutbox.findMany({
        where: { AND: [outboxDueWhere(nowDate), { workflowId }] },
        orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
        take,
        select: DUE_ROW_SELECT,
      });
    const urgentRows = await dueBatch({ in: [...URGENT_WORKFLOWS] }, limit);
    const dueRows =
      urgentRows.length < limit
        ? [
            ...urgentRows,
            ...(await dueBatch(
              { notIn: [...URGENT_WORKFLOWS] },
              limit - urgentRows.length,
            )),
          ]
        : urgentRows;

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
        if (isExpectedBellDeadLetter(outcome.deadLetterReason)) return true;
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
      if (outcome.terminalSplit) {
        result.deadLettered += 1;
        tickFailures.push({
          id: row.id,
          workflowId: row.workflowId,
          outcome: "DEAD_LETTER",
          error: outcome.terminalSplit,
        });
      }
      // A 429 drains the shared token bucket; further waves would only spend retries.
      return outcome.retryAfterMs === undefined;
    };

    if (dueRows.length > 0) {
      const startedAt = Date.now();
      const firstRow = dueRows[0];
      const firstOutcome = await attempt(firstRow, {
        relay: true,
        now,
        suppressSentry: true,
      });
      if (recordOutcome(firstRow, firstOutcome)) {
        const rest = dueRows.slice(1);
        for (let i = 0; i < rest.length; i += DRAIN_CONCURRENCY) {
          if (Date.now() - startedAt > WAVE_START_BUDGET_MS) break;
          const chunk = rest.slice(i, i + DRAIN_CONCURRENCY);
          const outcomes = await Promise.all(
            chunk.map((row) =>
              attempt(row, { relay: true, now, suppressSentry: true }),
            ),
          );
          let shouldContinue = true;
          for (let j = 0; j < chunk.length; j += 1) {
            if (!recordOutcome(chunk[j], outcomes[j])) shouldContinue = false;
          }
          if (!shouldContinue) break;
        }
      }
    }

    // Expected skips are counted but never recorded as failures, so they never page.
    const alertableDeadLetters = tickFailures.filter(
      (f) => f.outcome === "DEAD_LETTER",
    ).length;
    if (tickFailures.length > 0) {
      Sentry.captureException(
        new Error(
          `Notification outbox drain encountered ${tickFailures.length} failure(s) (${alertableDeadLetters} dead-lettered, ${result.retried} retried)`,
        ),
        {
          level: alertableDeadLetters > 0 ? "error" : "warning",
          tags: {
            subsystem: "novu",
            op: "drain-outbox",
            ...(alertableDeadLetters > 0 ? { outbox_dead_letter: "true" } : {}),
          },
          extra: {
            scanned: result.scanned,
            retried: result.retried,
            deadLettered: alertableDeadLetters,
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
      alertableDeadLetters,
    );

    if (typeof params.prisma.notificationOutbox.count === "function") {
      try {
        const [pendingCount, deadLetterCount] = await Promise.all([
          params.prisma.notificationOutbox.count({
            where: { status: { in: ["PENDING", "RETRY"] } },
          }),
          params.prisma.notificationOutbox.count({
            where: DEAD_LETTER_BELL_WHERE,
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

    if (alertableDeadLetters > 0) {
      const deadLetterWorkflows = [
        ...new Set(
          tickFailures
            .filter((f) => f.outcome === "DEAD_LETTER")
            .map((f) => f.workflowId),
        ),
      ].join(", ");
      await postOpsChat(
        `:rotating_light: Notification outbox dead-lettered ${alertableDeadLetters} row(s) (${deadLetterWorkflows || "unknown"})`,
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
// the Idempotency-Key is the backstop, not the design.
export async function drainNotificationOutbox(opts?: {
  limit?: number;
}): Promise<NotificationDrainResult> {
  return withCronLock("drain-notification-outbox", { failMode: "closed" }, () =>
    runNotificationDrainTick({ prisma, maxBatch: opts?.limit }),
  );
}
