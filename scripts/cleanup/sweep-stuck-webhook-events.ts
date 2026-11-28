/**
 * Background recovery sweeper that re-drives inbound webhook events left unprocessed
 * or transiently failed across the Razorpay and Stream handlers.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import { processStreamEvent } from "@/lib/stream/webhook-dispatch";
import { reclaimStaleProcessingWebhookEvent } from "@/lib/stream/webhook-receipt";
import { UNREADABLE_RAZORPAY_EVENT } from "@/schemas/webhooks/razorpay";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  gaveUpFailure,
  isTerminalWebhookError,
  TERMINAL_ERROR_PREFIXES,
  type WebhookClaim,
} from "@/lib/webhooks/event-log";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";

const DEFER_ALERT_THRESHOLD = 5;
const ALERT_AGE_HOURS = 1;
const PER_EVENT_TIMEOUT_MS = 15_000;

const streamEventPayloadSchema = z
  .object({
    call_cid: z.string().optional(),
  })
  .passthrough();

interface StuckWebhookRow {
  eventId: string;
  eventType: string;
  provider: string;
  payload: unknown;
  signature?: string | null;
  receivedAt: Date;
  claimedAt: Date | null;
  processed: boolean;
  deferCount: number;
  error?: string | null;
}

interface SweepCounters {
  recovered: number;
  stillFailing: number;
  stillFailingIds: string[];
  deferred: number;
  gaveUp: number;
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error) ?? "Unknown error";
}

function giveUpReason(provider: string): string {
  if (provider === "stream") {
    return "gave up: Stream event never became processable";
  }
  return "gave up: payment never arrived";
}

async function withEventTimeout<T>(
  eventId: string,
  task: () => Promise<T>,
  timeoutMs = PER_EVENT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Handler timed out after ${timeoutMs}ms for event ${eventId}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SweepResult {
  success: boolean;
  scanned: number;
  recovered: number;
  stillFailing: number;
  deferred: number;
  gaveUp: number;
  errors: string[];
}

export interface SweepOptions {
  /** Skip events newer than this window to avoid racing active webhook requests. */
  staleMinutes?: number;
  /** Warn threshold in hours for long-standing stuck webhook rows. */
  maxAgeHours?: number;
  /** Terminal age cap in hours after which deferred events stop retrying. */
  giveUpAfterHours?: number;
  limit?: number;
}

export async function sweepStuckWebhookEvents(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  return withCronLock(
    "sweep-stuck-webhook-events",
    { failMode: "closed" },
    () => sweepStuckWebhookEventsUnlocked(opts),
  );
}

async function emitBatchWarningsIfNeeded(
  stuck: StuckWebhookRow[],
  warnOlderThan: Date,
  warnAgeHours: number,
  alertOlderThan: Date,
  alertState: { warnedAged: boolean; alertedStalling: boolean },
): Promise<void> {
  if (!alertState.warnedAged) {
    const aged = stuck.filter((ev) => ev.receivedAt < warnOlderThan);
    if (aged.length > 0) {
      alertState.warnedAged = true;
      console.warn(
        `⚠️  Sweeping ${aged.length} stuck webhook event(s) older than ${warnAgeHours}h ` +
          `(oldest: ${aged[0].eventId} @ ${aged[0].receivedAt.toISOString()})`,
      );
    }
  }

  if (!alertState.alertedStalling) {
    const stalling = stuck.filter(
      (ev) =>
        !ev.processed &&
        (ev.deferCount >= DEFER_ALERT_THRESHOLD ||
          ev.receivedAt < alertOlderThan),
    );
    if (stalling.length > 0) {
      alertState.alertedStalling = true;
      const message =
        `sweep-stuck-webhook-events: ${stalling.length} webhook event(s) still unprocessed ` +
        `(deferCount >= ${DEFER_ALERT_THRESHOLD} or older than ${ALERT_AGE_HOURS}h)`;
      // A queue for the console, not Sentry; a re-drive that throws still pages below.
      await reportStandingFinding({
        key: "sweep-stuck-webhook-events:stalling",
        ids: stalling.map((ev) => ev.eventId),
        message,
      });
    }
  }
}

async function dispatchClaimedStuckEvent(
  ev: StuckWebhookRow,
  claim: WebhookClaim,
): Promise<void> {
  if (ev.provider === "stream") {
    const parsedStream = streamEventPayloadSchema.safeParse(ev.payload);
    const callCid = parsedStream.success
      ? parsedStream.data.call_cid
      : undefined;
    await withEventTimeout(ev.eventId, () =>
      processStreamEvent(
        ev.payload,
        ev.eventType,
        ev.eventId,
        { call_cid: callCid },
        claim,
      ),
    );
    return;
  }

  // Dispatch parses the stored event itself; a row stored whole (it named no
  // event) is handed back as it was received.
  const payloadKeys =
    typeof ev.payload === "object" &&
    ev.payload !== null &&
    !Array.isArray(ev.payload)
      ? Object.keys(ev.payload)
      : [];
  const storedEvent =
    ev.eventType === UNREADABLE_RAZORPAY_EVENT
      ? ev.payload
      : {
          entity: "event",
          account_id: "swept",
          event: ev.eventType,
          contains: payloadKeys,
          created_at: Math.floor(ev.receivedAt.getTime() / 1000),
          payload: ev.payload,
        };
  await withEventTimeout(ev.eventId, () =>
    processRazorpayWebhookEvent(
      storedEvent,
      ev.eventType,
      ev.eventId,
      claim,
      ev.receivedAt,
    ),
  );
}

async function markWebhookEventFailed(
  ev: StuckWebhookRow,
  claim: WebhookClaim,
  msg: string,
): Promise<void> {
  const rotatedClaimedAt = new Date();
  await prisma.webhookEvent
    .updateMany({
      where: {
        eventId: ev.eventId,
        processed: false,
        claimedAt: claim.claimedAt,
      },
      data: {
        processed: false,
        processedAt: null,
        claimedAt: rotatedClaimedAt,
        error: `sweep-failed: ${msg}`,
        ...(ev.provider !== "razorpay" ? { deferCount: { increment: 1 } } : {}),
      },
    })
    .catch(() => {});
}

async function settleDispatchedEventOutcome(
  ev: StuckWebhookRow,
  claim: WebhookClaim,
  giveUpOlderThan: Date,
  giveUpAfterHours: number,
  counts: SweepCounters,
): Promise<void> {
  const after = await prisma.webhookEvent.findUnique({
    where: { eventId: ev.eventId },
    select: { error: true, processed: true },
  });

  if (after?.error !== null && after?.error !== undefined) {
    if (ev.provider !== "razorpay" && !isTerminalWebhookError(after.error)) {
      await prisma.webhookEvent
        .updateMany({
          where: {
            eventId: ev.eventId,
            processed: false,
          },
          data: { deferCount: { increment: 1 } },
        })
        .catch(() => {});
    }
    counts.stillFailing++;
    counts.stillFailingIds.push(ev.eventId);
    counts.errors.push(`${ev.eventId}: ${after.error}`);
    return;
  }

  if (after && !after.processed) {
    if (ev.receivedAt < giveUpOlderThan) {
      const rotatedClaimedAt = new Date();
      await prisma.webhookEvent
        .updateMany({
          where: {
            eventId: ev.eventId,
            processed: false,
            claimedAt: claim.claimedAt,
          },
          data: {
            processed: false,
            processedAt: null,
            claimedAt: rotatedClaimedAt,
            error: giveUpReason(ev.provider),
          },
        })
        .catch(() => {});
      counts.gaveUp++;
      counts.errors.push(`${ev.eventId}: ${giveUpReason(ev.provider)}`);
      console.warn(
        `🛑 Gave up on stuck webhook ${ev.eventId} (deferred since ${ev.receivedAt.toISOString()}, past ${giveUpAfterHours}h cap)`,
      );
      return;
    }

    if (ev.provider !== "razorpay") {
      await prisma.webhookEvent
        .updateMany({
          where: {
            eventId: ev.eventId,
            processed: false,
            claimedAt: claim.claimedAt,
          },
          data: { deferCount: { increment: 1 } },
        })
        .catch(() => {});
    }

    counts.deferred++;
    console.log(`⏳ Stuck webhook ${ev.eventId} still deferred — will retry`);
    return;
  }

  counts.recovered++;
  console.log(`✅ Re-drove stuck webhook ${ev.eventId}`);
}

/**
 * An event still failing at the retry cap is stamped terminal, keeping its
 * last error, instead of dropping out of the queue unmarked. A compare-and-set
 * on the claim and the error read; it is not re-driven again.
 */
async function giveUpErroredEvent(
  ev: StuckWebhookRow & { error: string },
  giveUpAfterHours: number,
  counts: SweepCounters,
): Promise<boolean> {
  const error = gaveUpFailure(
    `still failing after ${giveUpAfterHours}h: ${ev.error}`,
  );
  const stamped = await prisma.webhookEvent.updateMany({
    where: {
      eventId: ev.eventId,
      processed: false,
      claimedAt: ev.claimedAt,
      error: ev.error,
    },
    data: { claimedAt: new Date(), error },
  });
  if (stamped.count === 0) return false;
  counts.gaveUp++;
  counts.errors.push(`${ev.eventId}: ${error}`);
  console.warn(
    `🛑 Gave up on failing webhook ${ev.eventId} (received ${ev.receivedAt.toISOString()}, past the ${giveUpAfterHours}h cap)`,
  );
  return true;
}

async function processOneStuckEvent(
  ev: StuckWebhookRow,
  giveUpOlderThan: Date,
  giveUpAfterHours: number,
  counts: SweepCounters,
): Promise<boolean> {
  if (ev.error && ev.receivedAt < giveUpOlderThan) {
    return giveUpErroredEvent(
      { ...ev, error: ev.error },
      giveUpAfterHours,
      counts,
    );
  }
  const { reclaimed, claim } = await reclaimStaleProcessingWebhookEvent(
    ev.eventId,
    ev.claimedAt,
  );
  if (!reclaimed) {
    console.log(
      `⏭️ Skipping ${ev.eventId} — claimed by another driver since selection`,
    );
    return false;
  }

  try {
    await dispatchClaimedStuckEvent(ev, claim);
    await settleDispatchedEventOutcome(
      ev,
      claim,
      giveUpOlderThan,
      giveUpAfterHours,
      counts,
    );
  } catch (e) {
    counts.stillFailing++;
    counts.stillFailingIds.push(ev.eventId);
    const msg = toErrorMessage(e);
    counts.errors.push(`${ev.eventId}: ${msg}`);
    await markWebhookEventFailed(ev, claim, msg);
  }

  return true;
}

/** Shared by the sweep's batch query and the ticker's idle probe. */
function stuckWebhookEventWhere(
  staleBefore: Date,
): Prisma.WebhookEventWhereInput {
  return {
    provider: { in: ["razorpay", "stream"] },
    receivedAt: { lt: staleBefore },
    AND: [
      {
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
    ],
    OR: [
      { processed: false, error: null },
      // An errored row stays selected at any age until it is terminal: past
      // the cap the sweep stamps it, it never just stops matching.
      {
        error: { not: null },
        AND: TERMINAL_ERROR_PREFIXES.map((prefix) => ({
          NOT: { error: { startsWith: prefix } },
        })),
      },
    ],
  };
}

const DEFAULT_STALE_MINUTES = 6;
const DEFAULT_GIVE_UP_AFTER_HOURS = 168;

/** True when the sweep's default-window query would find at least one event. */
export async function hasStuckWebhookEventWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.webhookEvent.findFirst({
    where: stuckWebhookEventWhere(
      new Date(now.getTime() - DEFAULT_STALE_MINUTES * 60_000),
    ),
    select: { id: true },
  });
  return row !== null;
}

async function sweepStuckWebhookEventsUnlocked(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const staleMinutes = opts.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const warnAgeHours = opts.maxAgeHours ?? 72;
  const giveUpAfterHours = opts.giveUpAfterHours ?? DEFAULT_GIVE_UP_AFTER_HOURS;
  const BATCH_SIZE = opts.limit ?? 200;
  const startMs = Date.now();
  const staleBefore = new Date(startMs - staleMinutes * 60_000);
  const warnOlderThan = new Date(startMs - warnAgeHours * 3_600_000);
  const alertOlderThan = new Date(startMs - ALERT_AGE_HOURS * 3_600_000);
  const giveUpOlderThan = new Date(startMs - giveUpAfterHours * 3_600_000);

  const counts: SweepCounters = {
    recovered: 0,
    stillFailing: 0,
    stillFailingIds: [],
    deferred: 0,
    gaveUp: 0,
    errors: [],
  };
  const alertState = { warnedAged: false, alertedStalling: false };
  let scanned = 0;

  while (Date.now() - startMs < 15_000) {
    const stuck = await prisma.webhookEvent.findMany({
      where: stuckWebhookEventWhere(staleBefore),
      orderBy: [
        { claimedAt: { sort: "asc", nulls: "first" } },
        { receivedAt: "asc" },
      ],
      take: BATCH_SIZE,
    });

    if (stuck.length === 0) break;
    scanned += stuck.length;

    await emitBatchWarningsIfNeeded(
      stuck,
      warnOlderThan,
      warnAgeHours,
      alertOlderThan,
      alertState,
    );

    let passProgress = 0;
    for (const ev of stuck) {
      const claimed = await processOneStuckEvent(
        ev,
        giveUpOlderThan,
        giveUpAfterHours,
        counts,
      );
      if (claimed) passProgress++;
    }

    if (stuck.length < BATCH_SIZE || passProgress === 0) break;
  }

  if (counts.stillFailing > 0) {
    const message = `sweep-stuck-webhook-events: ${counts.stillFailing} re-driven webhook event(s) still failing`;
    await reportStandingFinding(
      {
        key: "sweep-stuck-webhook-events:still-failing",
        ids: counts.stillFailingIds,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "jobs",
          op: "sweep-stuck-webhook-events",
          level: "error",
          expected: false,
          extra: {
            stillFailing: counts.stillFailing,
            errors: counts.errors.slice(0, 20),
          },
        }),
    );
  }

  return {
    success: true,
    scanned,
    recovered: counts.recovered,
    stillFailing: counts.stillFailing,
    deferred: counts.deferred,
    gaveUp: counts.gaveUp,
    errors: counts.errors,
  };
}
