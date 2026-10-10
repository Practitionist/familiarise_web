/**
 * Background recovery sweeper that re-drives inbound webhook events left unprocessed
 * or transiently failed across Razorpay, Stream, and Novu handlers.
 */
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { processNovuWebhookPayload } from "@/app/api/webhooks/novu/route";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import { processStreamEvent } from "@/lib/stream/webhook-dispatch";
import { reclaimStaleProcessingWebhookEvent } from "@/lib/stream/webhook-receipt";
import { novuWebhookPayloadSchema } from "@/schemas/webhooks/novu";
import { razorpayWebhookEnvelopeSchema } from "@/schemas/webhooks/razorpay";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  permanentFailure,
  TERMINAL_ERROR_PREFIXES,
} from "@/lib/webhooks/event-log";
import { reportSentryMessage } from "@/lib/observability/report";

const DEFER_ALERT_THRESHOLD = 5;
const ALERT_AGE_HOURS = 1;
const PER_EVENT_TIMEOUT_MS = 15_000;

const streamEventPayloadSchema = z
  .object({
    call_cid: z.string().optional(),
  })
  .passthrough();

function giveUpReason(provider: string): string {
  if (provider === "stream") {
    return "gave up: Stream event never became processable";
  }
  if (provider === "novu") {
    return "gave up: Novu event never became processable";
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

async function sweepStuckWebhookEventsUnlocked(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const staleMinutes = opts.staleMinutes ?? 6;
  const warnAgeHours = opts.maxAgeHours ?? 72;
  const giveUpAfterHours = opts.giveUpAfterHours ?? 168;
  const BATCH_SIZE = opts.limit ?? 200;
  const startMs = Date.now();
  const staleBefore = new Date(startMs - staleMinutes * 60_000);
  const warnOlderThan = new Date(startMs - warnAgeHours * 3_600_000);
  const alertOlderThan = new Date(startMs - ALERT_AGE_HOURS * 3_600_000);
  const giveUpOlderThan = new Date(startMs - giveUpAfterHours * 3_600_000);

  const errors: string[] = [];
  let scanned = 0;
  let recovered = 0;
  let stillFailing = 0;
  let deferred = 0;
  let gaveUp = 0;
  let warnedAged = false;
  let alertedStalling = false;

  while (Date.now() - startMs < 15_000) {
    const stuck = await prisma.webhookEvent.findMany({
      where: {
        provider: { in: ["razorpay", "stream", "novu"] },
        receivedAt: { lt: staleBefore },
        AND: [
          {
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
          },
        ],
        OR: [
          { processed: false, error: null },
          {
            error: { not: null },
            receivedAt: { gte: giveUpOlderThan },
            AND: TERMINAL_ERROR_PREFIXES.map((prefix) => ({
              NOT: { error: { startsWith: prefix } },
            })),
          },
        ],
      },
      orderBy: [
        { claimedAt: { sort: "asc", nulls: "first" } },
        { receivedAt: "asc" },
      ],
      take: BATCH_SIZE,
    });

    if (stuck.length === 0) break;
    scanned += stuck.length;

    if (!warnedAged) {
      const aged = stuck.filter((ev) => ev.receivedAt < warnOlderThan);
      if (aged.length > 0) {
        warnedAged = true;
        console.warn(
          `⚠️  Sweeping ${aged.length} stuck webhook event(s) older than ${warnAgeHours}h ` +
            `(oldest: ${aged[0].eventId} @ ${aged[0].receivedAt.toISOString()})`,
        );
      }
    }

    if (!alertedStalling) {
      const stalling = stuck.filter(
        (ev) =>
          !ev.processed &&
          (ev.deferCount >= DEFER_ALERT_THRESHOLD ||
            ev.receivedAt < alertOlderThan),
      );
      if (stalling.length > 0) {
        alertedStalling = true;
        Sentry.captureMessage(
          `sweep-stuck-webhook-events: ${stalling.length} webhook event(s) still unprocessed ` +
            `(deferCount >= ${DEFER_ALERT_THRESHOLD} or older than ${ALERT_AGE_HOURS}h)`,
          {
            level: "warning",
            tags: { subsystem: "payments", job: "sweep-stuck-webhook-events" },
            contexts: {
              stuckWebhooks: {
                count: stalling.length,
                events: stalling.slice(0, 20).map((ev) => ({
                  eventId: ev.eventId,
                  provider: ev.provider,
                  eventType: ev.eventType,
                  deferCount: ev.deferCount,
                  receivedAt: ev.receivedAt.toISOString(),
                })),
              },
            },
          },
        );
      }
    }

    let passProgress = 0;

    for (const ev of stuck) {
      const { reclaimed, claim } = await reclaimStaleProcessingWebhookEvent(
        ev.eventId,
        ev.claimedAt,
      );
      if (!reclaimed) {
        console.log(
          `⏭️ Skipping ${ev.eventId} — claimed by another driver since selection`,
        );
        continue;
      }
      passProgress++;

      try {
        if (ev.provider === "novu") {
          const parsedNovu = novuWebhookPayloadSchema.safeParse(ev.payload);
          if (!parsedNovu.success) {
            await prisma.webhookEvent.updateMany({
              where: {
                eventId: ev.eventId,
                processed: false,
                claimedAt: claim.claimedAt,
              },
              data: {
                processed: false,
                processedAt: null,
                error: permanentFailure("invalid Novu webhook payload"),
              },
            });
            stillFailing++;
            errors.push(`${ev.eventId}: invalid Novu webhook payload`);
            continue;
          }
          await withEventTimeout(ev.eventId, () =>
            processNovuWebhookPayload(parsedNovu.data, ev.eventId),
          );
          await prisma.webhookEvent.updateMany({
            where: {
              eventId: ev.eventId,
              processed: false,
              claimedAt: claim.claimedAt,
            },
            data: {
              processed: true,
              processedAt: new Date(),
              error: null,
            },
          });
        } else if (ev.provider === "stream") {
          const parsedStream = streamEventPayloadSchema.safeParse(ev.payload);
          const callCid = parsedStream.success
            ? parsedStream.data.call_cid
            : undefined;
          await withEventTimeout(ev.eventId, () =>
            processStreamEvent(
              ev.payload,
              ev.eventType,
              ev.eventId,
              ev.signature ?? undefined,
              { call_cid: callCid },
              { claimAlreadyHeld: true, claim },
            ),
          );
        } else {
          const payloadKeys =
            typeof ev.payload === "object" &&
            ev.payload !== null &&
            !Array.isArray(ev.payload)
              ? Object.keys(ev.payload)
              : [];
          const parsedEnvelope = razorpayWebhookEnvelopeSchema.safeParse({
            entity: "event",
            account_id: "swept",
            event: ev.eventType,
            contains: payloadKeys,
            created_at: Math.floor(ev.receivedAt.getTime() / 1000),
            payload: ev.payload,
          });
          if (!parsedEnvelope.success) {
            await prisma.webhookEvent.updateMany({
              where: {
                eventId: ev.eventId,
                processed: false,
                claimedAt: claim.claimedAt,
              },
              data: {
                processed: false,
                processedAt: null,
                error: permanentFailure("invalid Razorpay webhook payload"),
              },
            });
            stillFailing++;
            errors.push(`${ev.eventId}: invalid Razorpay webhook payload`);
            continue;
          }
          await withEventTimeout(ev.eventId, () =>
            processRazorpayWebhookEvent(
              parsedEnvelope.data,
              ev.eventType,
              ev.eventId,
              claim,
            ),
          );
        }

        const after = await prisma.webhookEvent.findUnique({
          where: { eventId: ev.eventId },
          select: { error: true, processed: true },
        });
        if (after?.error !== null && after?.error !== undefined) {
          stillFailing++;
          errors.push(`${ev.eventId}: ${after.error}`);
        } else if (after && !after.processed) {
          if (ev.receivedAt < giveUpOlderThan) {
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
                  error: giveUpReason(ev.provider),
                },
              })
              .catch(() => {});
            gaveUp++;
            errors.push(`${ev.eventId}: ${giveUpReason(ev.provider)}`);
            console.warn(
              `🛑 Gave up on stuck webhook ${ev.eventId} (deferred since ${ev.receivedAt.toISOString()}, past ${giveUpAfterHours}h cap)`,
            );
          } else {
            deferred++;
            console.log(
              `⏳ Stuck webhook ${ev.eventId} still deferred — will retry`,
            );
          }
        } else {
          recovered++;
          console.log(`✅ Re-drove stuck webhook ${ev.eventId}`);
        }
      } catch (e) {
        stillFailing++;
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${ev.eventId}: ${msg}`);
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
              error: `sweep-failed: ${msg}`,
            },
          })
          .catch(() => {});
      }
    }

    if (stuck.length < BATCH_SIZE || passProgress === 0) break;
  }

  if (stillFailing > 0) {
    reportSentryMessage(
      `sweep-stuck-webhook-events: ${stillFailing} re-driven webhook event(s) still failing`,
      {
        subsystem: "jobs",
        op: "sweep-stuck-webhook-events",
        level: "error",
        expected: false,
        extra: { stillFailing, errors: errors.slice(0, 20) },
      },
    );
  }

  return {
    success: true,
    scanned,
    recovered,
    stillFailing,
    deferred,
    gaveUp,
    errors,
  };
}
