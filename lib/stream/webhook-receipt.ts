import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { scrubStreamEventForStorage } from "@/lib/stream/webhook-payload-scrub";
import { toInputJson, type WebhookClaim } from "@/lib/webhooks/event-log";

const STALE_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_STALE_RECLAIM_RETRIES = 5;

/** Re-claims an unprocessed row only if its `claimedAt` still equals the snapshot the caller selected. */
export async function reclaimStaleProcessingWebhookEvent(
  eventId: string,
  priorClaimedAt: Date | null,
): Promise<{ reclaimed: boolean; claim: WebhookClaim }> {
  const claimedAt = new Date();
  const claimed = await prisma.webhookEvent.updateMany({
    where: { eventId, processed: false, claimedAt: priorClaimedAt },
    data: { claimedAt, error: null, deferCount: { increment: 1 } },
  });
  return {
    reclaimed: claimed.count > 0,
    claim: { claimedAt: claimed.count > 0 ? claimedAt : null },
  };
}

/** Re-claims a redelivered row whose earlier attempt was abandoned without an error, within the retry cap. */
export async function reclaimAbandonedWebhookReceipt(
  eventId: string,
  now: Date = new Date(),
): Promise<{ reclaimed: boolean; claim: WebhookClaim }> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_THRESHOLD_MS);
  const claimed = await prisma.webhookEvent.updateMany({
    where: {
      eventId,
      processed: false,
      error: null,
      deferCount: { lt: MAX_STALE_RECLAIM_RETRIES },
      OR: [
        { claimedAt: { lt: staleBefore } },
        { claimedAt: null, receivedAt: { lt: staleBefore } },
      ],
    },
    data: { claimedAt: now, error: null, deferCount: { increment: 1 } },
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
    const reclaimed = await reclaimAbandonedWebhookReceipt(eventId);
    if (reclaimed.reclaimed) {
      return { isNew: true, claim: reclaimed.claim };
    }
  } catch {
    // A failed reclaim leaves the row to the sweeper; the delivery is still a duplicate.
  }
  return { isNew: false, claim: { claimedAt: null } };
}
