/**
 * #474 — Transactional-email retry worker; since #1654 also the outbox relay.
 *
 * Drains `FailedEmail` rows that lib/email/deliver.ts staged before its inline
 * send (status PENDING when that send timed out, failed transiently or never
 * ran; RETRY on any subsequent scheduled attempt) and whose `nextRetryAt` is
 * now or earlier. One tick:
 *
 *   1. Picks up to `MAX_BATCH` rows ordered by `nextRetryAt ASC NULLS FIRST`.
 *   2. Dead-letters a row that carried a single-use code or link without a
 *      send: its body is stored redacted (lib/email/classify.ts).
 *   3. Rechecks the recipient's current account policy and suppression just
 *      before the send, and refuses a row first attempted 23 h or more ago:
 *      its Resend idempotency key may have expired (lib/retry/provider-window.ts).
 *   4. RE-SENDS the stored message verbatim — `resend.emails.send` with the
 *      persisted html/text/subject/from/replyTo. NO dispatcher, NO re-render:
 *      the row IS the rendered message, so retry can't drift from the original.
 *   5. Records the outcome:
 *        - success → status=SENT, sentAt=now.
 *        - failure → status=RETRY with the next backoff slot, OR
 *          status=DEAD_LETTER if we just used the last attempt (5) or the
 *          error is terminal (#1298: dead key, unverified domain).
 *
 * Backoff schedule (mirrors the outbound-webhook worker)
 * ------------------------------------------------------
 *   attempt 1 → 1 minute
 *   attempt 2 → 5 minutes
 *   attempt 3 → 30 minutes
 *   attempt 4 → 2 hours
 *   attempt 5 → 8 hours (last)
 *   attempt 6 → DEAD_LETTER (operator-replayable)
 *
 * Why a polled table instead of a queue: same rationale as
 * lib/enterprise/outbound-webhooks/worker.ts — Netlify/Vercel ship no
 * first-class queue, and an indexed (status, nextRetryAt) walk handles the
 * transactional-email volume comfortably. The table IS the queue.
 *
 * #1647 — two additions on the same tick and lock: a row whose recipient is on
 * `EmailSuppression` is dead-lettered without a send, and `FailedEmailBatch`
 * rows (the newsletter's batch requests) are replayed through
 * `resend.batch.send` under their stored idempotency key, five per tick.
 *
 * Best-effort by contract: a re-send failure increments + reschedules; it
 * never throws into the cron wrapper.
 */

import prisma, { type PrismaLike } from "@/lib/prisma";
import type {
  EmailSuppression,
  FailedEmail,
  FailedEmailBatch,
  Prisma,
} from "@prisma/client";
import {
  Resend,
  type CreateBatchRequestOptions,
  type CreateEmailRequestOptions,
} from "resend";
import { DEFAULT_FROM_ADDRESS, EMAIL_BUDGET_MS } from "@/lib/email/config";
import { batchMessagesSchema } from "@/lib/email/batch-payload";
import {
  carriesCredential,
  resendErrorText,
  terminalSendReason,
} from "@/lib/email/classify";
import {
  deliveryPolicyOf,
  emailPolicyRefusal,
  type EmailPolicyReader,
} from "@/lib/email/delivery-policy";
import { idempotencyKeyFor } from "@/lib/email/idempotency";
import {
  findSuppressed,
  normaliseEmail,
  type SuppressionReader,
} from "@/lib/email/suppression";
import { reconstructUnsubscribeHeaders } from "@/lib/email/unsubscribe";
import {
  HELD_PRE_LAUNCH,
  heldRecipientDomain,
  logHeld,
  recipientsOf,
} from "@/lib/email/delivery-guard";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { postOpsChat } from "@/lib/observability/ops-chat";
import { nextRetryAt } from "@/lib/retry/backoff";
import {
  providerWindowRefusal,
  stampFirstAttempt,
  UNSETTLED,
} from "@/lib/retry/provider-window";

const MAX_BATCH = 50;
const MAX_ATTEMPTS = 5;
const MAX_BATCH_ROWS = 5;
export const SEND_GAP_MS = 125;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export { BACKOFF_MS } from "@/lib/retry/backoff";

/** Rows and batches due a send at `now`; shared by the relay and the ticker's idle probe. */
function retryDueWhere(
  now: Date,
): Prisma.FailedEmailWhereInput & Prisma.FailedEmailBatchWhereInput {
  return {
    OR: [
      {
        status: "PENDING",
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      { status: "RETRY", nextRetryAt: { lte: now } },
    ],
  };
}

/** Ticker idle probe: a due email row or a due batch. */
export async function hasEmailRetryWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.failedEmail.findFirst({
    where: retryDueWhere(now),
    select: { id: true },
  });
  if (row) return true;
  if (outOfTime()) return true;
  const batch = await db.failedEmailBatch.findFirst({
    where: retryDueWhere(now),
    select: { id: true },
  });
  return batch !== null;
}

export interface EmailRetryRunResult {
  scanned: number;
  sent: number;
  retried: number;
  deadLettered: number;
  /** Expected refusals (policy, suppression, pre-launch hold): settled, never paged. */
  refused: number;
  batchesScanned: number;
  batchesSent: number;
  batchesRetried: number;
  batchesDeadLettered: number;
  errors: string[];
}

export interface FailedEmailStore extends EmailPolicyReader {
  failedEmail: {
    findMany(args: Prisma.FailedEmailFindManyArgs): Promise<FailedEmail[]>;
    updateMany(
      args: Prisma.FailedEmailUpdateManyArgs,
    ): Promise<Prisma.BatchPayload>;
    count?(args?: Prisma.FailedEmailCountArgs): Promise<number>;
  };
  emailSuppression: SuppressionReader["emailSuppression"] & {
    findUnique(args: {
      where: { email: string };
      select: { reason: true };
    }): Promise<Pick<EmailSuppression, "reason"> | null>;
  };
  failedEmailBatch: {
    findMany(
      args: Prisma.FailedEmailBatchFindManyArgs,
    ): Promise<FailedEmailBatch[]>;
    updateMany(
      args: Prisma.FailedEmailBatchUpdateManyArgs,
    ): Promise<Prisma.BatchPayload>;
  };
}

export interface RelaySender {
  emails: Pick<Resend["emails"], "send">;
  batch: Pick<Resend["batch"], "send">;
}

/** Settles a row only while it is unsettled; false when another attempt got there first. */
async function settleEmail(
  db: FailedEmailStore,
  id: string,
  data: Prisma.FailedEmailUpdateManyMutationInput,
): Promise<boolean> {
  const { count } = await db.failedEmail.updateMany({
    where: { id, status: UNSETTLED },
    data,
  });
  return count > 0;
}

async function settleBatch(
  db: FailedEmailStore,
  id: string,
  data: Prisma.FailedEmailBatchUpdateManyMutationInput,
): Promise<boolean> {
  const { count } = await db.failedEmailBatch.updateMany({
    where: { id, status: UNSETTLED },
    data,
  });
  return count > 0;
}

/** Current account policy, then suppression, read just before a send; throws on a failed read. */
async function recipientRefusal(
  db: FailedEmailStore,
  row: FailedEmail,
): Promise<string | null> {
  const policy = await emailPolicyRefusal(
    deliveryPolicyOf(row),
    row.recipient,
    db,
  );
  if (policy) return `policy:${policy}`;
  const suppression = await db.emailSuppression.findUnique({
    where: { email: normaliseEmail(row.recipient) },
    select: { reason: true },
  });
  return suppression ? `suppressed:${suppression.reason}` : null;
}

/** Rows a failed read left pending; reported once per tick, never sent. */
interface RecheckFailures {
  count: number;
  last?: string;
}

function noteRecheckFailure(failures: RecheckFailures, error: unknown): void {
  failures.count += 1;
  failures.last = error instanceof Error ? error.message : String(error);
}

interface DeadLetterAlert {
  message: string;
  fingerprint: [string, string];
  emailType: string;
  extra?: Record<string, unknown>;
}

export async function runEmailRetryTick(params: {
  prisma: FailedEmailStore;
  resend?: RelaySender;
  now?: () => number;
  maxBatch?: number;
}): Promise<EmailRetryRunResult> {
  const runBody = async (span?: Sentry.Span): Promise<EmailRetryRunResult> => {
    const { prisma } = params;
    const now = params.now ?? (() => Date.now());
    const batchLimit = params.maxBatch ?? MAX_BATCH;

    const result: EmailRetryRunResult = {
      scanned: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
      refused: 0,
      batchesScanned: 0,
      batchesSent: 0,
      batchesRetried: 0,
      batchesDeadLettered: 0,
      errors: [],
    };

    const sender = params.resend ?? buildResendSender();
    if (!sender) {
      result.errors.push("RESEND_API_KEY not configured; skipping email retry");
      return result;
    }
    const { emails } = sender;

    const nowDate = new Date(now());
    const dueRows = await prisma.failedEmail.findMany({
      where: retryDueWhere(nowDate),
      orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
      take: batchLimit,
    });

    const alerts = new Map<string, DeadLetterAlert>();
    const recheckFailures: RecheckFailures = { count: 0 };

    for (const [index, row] of dueRows.entries()) {
      result.scanned += 1;

      // A recorded receipt means Resend accepted it; settle instead of sending again.
      if (row.resendId || row.sentAt) {
        if (
          await settleEmail(prisma, row.id, {
            status: "SENT",
            sentAt: row.sentAt ?? nowDate,
            lastError: null,
          })
        ) {
          result.sent += 1;
        }
        continue;
      }

      const heldDomain = heldRecipientDomain(row.recipient);
      if (heldDomain) {
        logHeld(row.emailType, heldDomain);
        if (
          await settleEmail(prisma, row.id, {
            status: "DEAD_LETTER",
            lastError: HELD_PRE_LAUNCH,
          })
        ) {
          result.refused += 1;
        }
        continue;
      }

      if (carriesCredential(row.emailType)) {
        if (
          await settleEmail(prisma, row.id, {
            status: "DEAD_LETTER",
            lastError: `not replayed: ${row.emailType} carried a single-use credential`,
          })
        ) {
          result.deadLettered += 1;
        }
        continue;
      }

      const windowRefusal = providerWindowRefusal(row.firstAttemptAt, nowDate);
      if (windowRefusal) {
        if (
          await settleEmail(prisma, row.id, {
            status: "DEAD_LETTER",
            lastError: windowRefusal,
          })
        ) {
          result.deadLettered += 1;
        }
        continue;
      }

      if (index > 0) await sleep(SEND_GAP_MS);

      let refusal: string | null;
      try {
        refusal = await recipientRefusal(prisma, row);
        if (!refusal) {
          await stampFirstAttempt(prisma.failedEmail, row.id, new Date(now()));
        }
      } catch (error) {
        noteRecheckFailure(recheckFailures, error);
        continue;
      }
      if (refusal) {
        if (
          await settleEmail(prisma, row.id, {
            status: "DEAD_LETTER",
            lastError: refusal,
          })
        ) {
          result.refused += 1;
        }
        continue;
      }

      let sendError: string | undefined;
      let resendId: string | null = null;
      try {
        const result = await emails.send(
          {
            from: row.fromAddress ?? DEFAULT_FROM_ADDRESS,
            to: row.recipient,
            subject: row.subject,
            html: row.htmlBody,
            text: row.textBody ?? undefined,
            replyTo: row.replyTo ?? undefined,
            headers: reconstructUnsubscribeHeaders(row),
          },
          {
            idempotencyKey:
              idempotencyKeyFor(
                { to: row.recipient, subject: row.subject, html: row.htmlBody },
                row.emailType,
                row.id,
              ) || `failed-email:${row.id}`,
            signal: AbortSignal.timeout(EMAIL_BUDGET_MS.JOB),
          } as CreateEmailRequestOptions,
        );
        if (result.error) {
          sendError = resendErrorText(result.error);
        } else {
          resendId = result.data?.id ?? null;
        }
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }

      if (!sendError) {
        if (
          await settleEmail(prisma, row.id, {
            status: "SENT",
            attempts: row.attempts + 1,
            sentAt: nowDate,
            lastError: null,
            resendId,
          })
        ) {
          result.sent += 1;
        }
        continue;
      }

      const attemptNumber = row.attempts + 1;
      const nextAttemptNumber = attemptNumber + 1;

      const terminalReason = terminalSendReason(sendError);
      if (terminalReason) {
        alerts.set(`terminal:${terminalReason}`, {
          message: `email retry hit a terminal error: ${sendError}`,
          fingerprint: ["email-retry-terminal", terminalReason],
          emailType: row.emailType,
        });
      } else if (attemptNumber >= MAX_ATTEMPTS) {
        alerts.set(`exhausted:${row.emailType}`, {
          message: `email retry exhausted ${MAX_ATTEMPTS} attempts (${row.emailType}): ${sendError}`,
          fingerprint: ["email-retry-exhausted", row.emailType],
          emailType: row.emailType,
          extra: {
            failedEmailId: row.id,
            attempts: attemptNumber,
            lastError: sendError,
          },
        });
      }

      if (terminalReason || attemptNumber >= MAX_ATTEMPTS) {
        if (
          await settleEmail(prisma, row.id, {
            status: "DEAD_LETTER",
            attempts: attemptNumber,
            lastError: sendError,
          })
        ) {
          result.deadLettered += 1;
        }
      } else if (
        await settleEmail(prisma, row.id, {
          status: "RETRY",
          attempts: attemptNumber,
          nextRetryAt: nextRetryAt(nextAttemptNumber, new Date(now())),
          lastError: sendError,
        })
      ) {
        result.retried += 1;
      }
    }

    await drainBatches({
      prisma,
      sender,
      now,
      result,
      alerts,
      recheckFailures,
    });
    if (recheckFailures.count > 0) {
      result.errors.push(
        `${recheckFailures.count} email(s) left pending: recipient recheck failed (${recheckFailures.last})`,
      );
    }

    for (const alert of alerts.values()) {
      Sentry.captureMessage(alert.message, {
        level: "error",
        fingerprint: alert.fingerprint,
        tags: {
          subsystem: "email",
          emailType: alert.emailType,
          outbox_dead_letter: "true",
        },
        ...(alert.extra && { extra: alert.extra }),
      });
    }

    const deadLetterCount = result.deadLettered + result.batchesDeadLettered;

    span?.setAttributes?.({
      "outbox.scanned": result.scanned,
      "outbox.sent": result.sent,
      "outbox.retried": result.retried,
      "outbox.dead_lettered": result.deadLettered,
      "outbox.refused": result.refused,
      "outbox.batches_scanned": result.batchesScanned,
      "outbox.batches_sent": result.batchesSent,
      "outbox.batches_retried": result.batchesRetried,
      "outbox.batches_dead_lettered": result.batchesDeadLettered,
    });

    Sentry.metrics?.count?.(
      "email.outbox.sent",
      result.sent + result.batchesSent,
    );
    Sentry.metrics?.count?.(
      "email.outbox.retried",
      result.retried + result.batchesRetried,
    );
    Sentry.metrics?.count?.("email.outbox.dead_lettered", deadLetterCount);
    Sentry.metrics?.gauge?.("email.outbox.dead_letter", deadLetterCount);

    if (deadLetterCount > 0) {
      await postOpsChat(
        `:warning: [email-outbox] ${deadLetterCount} email(s)/batch(es) dead-lettered (rows=${result.deadLettered}, batches=${result.batchesDeadLettered})`,
      );
    }

    if (typeof prisma.failedEmail.count === "function") {
      try {
        const pendingCount = await prisma.failedEmail.count({
          where: { status: { in: ["PENDING", "RETRY"] } },
        });
        Sentry.metrics?.gauge?.("email.outbox.pending", pendingCount);
      } catch {
        // Best-effort gauge; never fail the drain tick.
      }
    }

    return result;
  };

  if (typeof Sentry.startSpan === "function") {
    return Sentry.startSpan(
      { name: "email.outbox.drain", op: "queue.process" },
      runBody,
    );
  }
  return runBody(undefined);
}

async function drainBatches(ctx: {
  prisma: FailedEmailStore;
  sender: RelaySender;
  now: () => number;
  result: EmailRetryRunResult;
  alerts: Map<string, DeadLetterAlert>;
  recheckFailures: RecheckFailures;
}): Promise<void> {
  const { prisma, sender, now, result, alerts, recheckFailures } = ctx;
  const nowDate = new Date(now());
  const dueBatches = await prisma.failedEmailBatch.findMany({
    where: retryDueWhere(nowDate),
    orderBy: { createdAt: "asc" },
    take: MAX_BATCH_ROWS,
  });

  for (const [index, row] of dueBatches.entries()) {
    result.batchesScanned += 1;

    if (row.sentAt) {
      if (
        await settleBatch(prisma, row.id, { status: "SENT", lastError: null })
      ) {
        result.batchesSent += 1;
      }
      continue;
    }

    const parsed = batchMessagesSchema.safeParse(row.payload);
    if (!parsed.success) {
      if (
        await settleBatch(prisma, row.id, {
          status: "DEAD_LETTER",
          lastError: "invalid batch payload",
        })
      ) {
        result.batchesDeadLettered += 1;
      }
      continue;
    }
    let messages = parsed.data;

    const heldDomain = heldRecipientDomain(messages.flatMap(recipientsOf));
    if (heldDomain) {
      logHeld(row.emailType, heldDomain);
      if (
        await settleBatch(prisma, row.id, {
          status: "DEAD_LETTER",
          lastError: HELD_PRE_LAUNCH,
        })
      ) {
        result.refused += 1;
      }
      continue;
    }

    const windowRefusal = providerWindowRefusal(row.firstAttemptAt, nowDate);
    if (windowRefusal) {
      if (
        await settleBatch(prisma, row.id, {
          status: "DEAD_LETTER",
          lastError: windowRefusal,
        })
      ) {
        result.batchesDeadLettered += 1;
      }
      continue;
    }

    if (index > 0) await sleep(SEND_GAP_MS);

    let refusal: string | null = null;
    try {
      const suppressed = await findSuppressed(
        messages.map((m) => m.to),
        prisma,
      );
      const kept = messages.filter(
        (m) => !suppressed.has(normaliseEmail(m.to)),
      );
      if (kept.length === messages.length) {
        await stampFirstAttempt(
          prisma.failedEmailBatch,
          row.id,
          new Date(now()),
        );
      } else if (row.firstAttemptAt) {
        // The key may already name the full payload, so a narrowed one cannot reuse it.
        refusal = "review:batch_recipient_suppressed";
      } else if (kept.length === 0) {
        refusal = "suppressed:all_recipients";
      } else {
        // Resend has never seen this key, so the narrowed payload becomes the row's own.
        const claimed = await prisma.failedEmailBatch.updateMany({
          where: { id: row.id, firstAttemptAt: null },
          data: { firstAttemptAt: new Date(now()), payload: kept },
        });
        if (claimed.count === 0) continue;
        messages = kept;
      }
    } catch (error) {
      noteRecheckFailure(recheckFailures, error);
      continue;
    }
    if (refusal) {
      if (
        await settleBatch(prisma, row.id, {
          status: "DEAD_LETTER",
          lastError: refusal,
        })
      ) {
        if (refusal.startsWith("suppressed:")) result.refused += 1;
        else result.batchesDeadLettered += 1;
      }
      continue;
    }

    let sendError: string | undefined;
    try {
      const response = await sender.batch.send(messages, {
        idempotencyKey: row.idempotencyKey || `failed-email-batch:${row.id}`,
        signal: AbortSignal.timeout(EMAIL_BUDGET_MS.JOB),
      } as CreateBatchRequestOptions);
      if (response.error) sendError = resendErrorText(response.error);
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    if (!sendError) {
      if (
        await settleBatch(prisma, row.id, {
          status: "SENT",
          attempts: row.attempts + 1,
          sentAt: nowDate,
          lastError: null,
        })
      ) {
        result.batchesSent += 1;
      }
      continue;
    }

    const attemptNumber = row.attempts + 1;
    const terminalReason = terminalSendReason(sendError);
    if (terminalReason) {
      alerts.set(`terminal:${terminalReason}`, {
        message: `email retry hit a terminal error: ${sendError}`,
        fingerprint: ["email-retry-terminal", terminalReason],
        emailType: row.emailType,
      });
    } else if (attemptNumber >= MAX_ATTEMPTS) {
      alerts.set(`batch-exhausted:${row.emailType}`, {
        message: `email batch retry exhausted ${MAX_ATTEMPTS} attempts (${row.emailType}): ${sendError}`,
        fingerprint: ["email-batch-retry-exhausted", row.emailType],
        emailType: row.emailType,
        extra: {
          failedEmailBatchId: row.id,
          attempts: attemptNumber,
          lastError: sendError,
        },
      });
    }

    if (terminalReason || attemptNumber >= MAX_ATTEMPTS) {
      if (
        await settleBatch(prisma, row.id, {
          status: "DEAD_LETTER",
          attempts: attemptNumber,
          lastError: sendError,
        })
      ) {
        result.batchesDeadLettered += 1;
      }
    } else if (
      await settleBatch(prisma, row.id, {
        status: "RETRY",
        attempts: attemptNumber,
        nextRetryAt: nextRetryAt(attemptNumber + 1, nowDate),
        lastError: sendError,
      })
    ) {
      result.batchesRetried += 1;
    }
  }
}

// Resolve a Resend sender from the env key. Returns null when unset so the
// tick can bail cleanly instead of throwing on a missing key.
function buildResendSender(): RelaySender | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const client = new Resend(key);
  return { emails: client.emails, batch: client.batch };
}

// #476 — no IN_FLIGHT soft lock on FailedEmail, so the cron lock is the only
// thing keeping two overlapping ticks from double-sending a row.
// Wave-3 (#1230): flipped from fail-open to FAIL-CLOSED. The original rationale
// ("a missing lock shouldn't block the sweep") predates #1179's ops-paging:
// today a held/unavailable lock now fails the tick loudly and pages, whereas
// fail-open silently allowed two replicas to send every failed email twice.
// Deferred retries resume next tick once Redis recovers — no message loss,
// just delay.
export async function retryFailedEmails(opts?: {
  /** The ticker's per-tick bite; omitted, the run drains MAX_BATCH. */
  limit?: number;
}): Promise<EmailRetryRunResult> {
  return withCronLock("retry-failed-emails", { failMode: "closed" }, () =>
    runEmailRetryTick({ prisma, maxBatch: opts?.limit }),
  );
}
