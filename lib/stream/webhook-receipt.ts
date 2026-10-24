import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { scrubStreamEventForStorage } from "@/lib/stream/webhook-payload-scrub";
import { toInputJson, type WebhookClaim } from "@/lib/webhooks/event-log";

export const STALE_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000;
export const MAX_STALE_RECLAIM_RETRIES = 5;

export interface ReclaimStaleOptions {
  now?: Date;
  staleThresholdMs?: number;
  maxRetries?: number;
}

/**
 * Atomically reclaims an unprocessed webhook event row stuck in processing.
 * Mode 1 (`(eventId, priorClaimedAt)`) fences on the exact prior `claimedAt` snapshot;
 * Mode 2 (`(eventId, opts)`) reclaims rows stale beyond threshold with `deferCount < maxRetries`.
 */
export async function reclaimStaleProcessingWebhookEvent(
  eventId: string,
  priorClaimedAtOrOpts?: Date | null | ReclaimStaleOptions,
): Promise<{ reclaimed: boolean; claim: WebhookClaim }> {
  const isDateOrNull =
    priorClaimedAtOrOpts === undefined ||
    priorClaimedAtOrOpts === null ||
    priorClaimedAtOrOpts instanceof Date;

  if (isDateOrNull && arguments.length >= 2) {
    const claimedAt = new Date();
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        eventId,
        processed: false,
        claimedAt: priorClaimedAtOrOpts ?? null,
      },
      data: {
        claimedAt,
        error: null,
        deferCount: { increment: 1 },
      },
    });
    return {
      reclaimed: claimed.count > 0,
      claim: { claimedAt: claimed.count > 0 ? claimedAt : null },
    };
  }

  const opts: ReclaimStaleOptions =
    typeof priorClaimedAtOrOpts === "object" &&
    priorClaimedAtOrOpts !== null &&
    !(priorClaimedAtOrOpts instanceof Date)
      ? priorClaimedAtOrOpts
      : {};
  const now = opts.now ?? new Date();
  const thresholdMs = opts.staleThresholdMs ?? STALE_PROCESSING_THRESHOLD_MS;
  const maxRetries = opts.maxRetries ?? MAX_STALE_RECLAIM_RETRIES;
  const staleBefore = new Date(now.getTime() - thresholdMs);

  const claimed = await prisma.webhookEvent.updateMany({
    where: {
      eventId,
      processed: false,
      error: null,
      deferCount: { lt: maxRetries },
      OR: [
        { claimedAt: { lt: staleBefore } },
        { claimedAt: null, receivedAt: { lt: staleBefore } },
      ],
    },
    data: {
      claimedAt: now,
      error: null,
      deferCount: { increment: 1 },
    },
  });

  return {
    reclaimed: claimed.count > 0,
    claim: { claimedAt: claimed.count > 0 ? now : null },
  };
}

/**
 * Records a verified Stream webhook delivery before HTTP acknowledgement with one
 * `create`: the unique `eventId` index is the duplicate check, so a P2002 is a
 * duplicate (`isNew: false`) and only then is a stale in-progress row reclaimed.
 * The stored payload keeps only the fields the handlers and the sweeper read.
 */
export async function recordStreamEventReceipt(
  eventId: string,
  eventType: string,
  event: unknown,
  signature: string | undefined,
): Promise<{ isNew: boolean; claim: WebhookClaim }> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: "stream",
        eventId,
        eventType,
        payload: toInputJson(scrubStreamEventForStorage(eventType, event)),
        signature,
        processed: false,
      },
    });
    return { isNew: true, claim: { claimedAt: null } };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  try {
    const reclaimed = await reclaimStaleProcessingWebhookEvent(eventId);
    if (reclaimed.reclaimed) {
      return { isNew: true, claim: reclaimed.claim };
    }
  } catch {
    // A failed reclaim leaves the row to the sweeper; the delivery is still a duplicate.
  }
  return { isNew: false, claim: { claimedAt: null } };
}
