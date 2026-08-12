/**
 * Shared webhook bookkeeping: the delivery log that gives every provider
 * idempotency, and the DB-health probe handlers gate on.
 *
 * #1134 P1-2 — moved out of `app/api/webhooks/utils.ts` because the Stream
 * dispatch now lives in `lib/` (so the stuck-event sweeper can re-drive it) and
 * `lib/` may not import from `app/`. `app/api/webhooks/utils.ts` re-exports
 * these, so every existing caller is unchanged.
 */
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Lightweight DB health check for webhook handlers.
 *
 * Returns false when the DB is unreachable or mid-migration.
 * Webhook handlers should return 503 when this is false — payment gateways
 * (Stripe, Razorpay, etc.) will retry the webhook automatically after a
 * delay, so no events are lost.
 */
export async function isDbHealthy(): Promise<boolean> {
  try {
    // ORM connectivity probe (no raw SQL): a LIMIT 1 read proves the connection.
    await prisma.user.findFirst({ select: { id: true } });
    return true;
  } catch (error) {
    // Handlers 503 on false so gateways retry — correct for a transient
    // outage, but a persistent non-connectivity fault (e.g. schema drift)
    // would 503 every webhook forever with no signal. Report it (#1125).
    reportSentryError(error, {
      subsystem: "webhooks",
      op: "isDbHealthy",
      expected: false,
    });
    return false;
  }
}

/**
 * Log webhook event for audit trail and debugging.
 * Prevents duplicate processing via unique eventId constraint.
 *
 * If a previous attempt exists but failed (has error and processed=true),
 * it is eligible for retry — returns isNew: true so the handler re-runs.
 */
export async function logWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<{ isNew: boolean; eventRecordId?: string }> {
  try {
    // Check if event already exists
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      // Three-state machine using processed + error fields:
      //   processed=true  + no error  → SUCCESS: skip (idempotent)
      //   processed=true  + error set → FAILED:  allow retry (reset & re-process)
      //   processed=false + no error  → IN-PROGRESS: skip (another worker handling it)
      // This avoids a separate status enum while letting providers like Stream
      // retry failed events instead of silently dropping them.
      // If previously processed successfully, skip (true idempotency)
      if (existing.processed && !existing.error) {
        console.log(
          `⚠️ Webhook event ${eventId} already processed successfully, skipping`,
        );
        return { isNew: false, eventRecordId: existing.id };
      }

      // If previous attempt failed, allow retry by resetting state
      if (existing.error) {
        console.log(
          `🔄 Webhook event ${eventId} previously failed, allowing retry`,
        );
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        return { isNew: true, eventRecordId: existing.id };
      }

      // Currently being processed (processed=false, no error).
      // Add staleness check: if the event has been "in progress" for > 5 minutes,
      // treat it as abandoned (e.g., after() callback didn't run due to crash)
      // and allow reprocessing.
      const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const age = Date.now() - new Date(existing.receivedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        console.log(
          `🔄 Webhook event ${eventId} stale (in-progress for ${Math.round(age / 1000)}s), allowing retry`,
        );
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        return { isNew: true, eventRecordId: existing.id };
      }

      console.log(
        `⚠️ Webhook event ${eventId} currently being processed, skipping`,
      );
      return { isNew: false, eventRecordId: existing.id };
    }

    // Create new event record
    const event = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        signature,
        processed: false,
      },
    });

    return { isNew: true, eventRecordId: event.id };
  } catch (error) {
    // Handle unique constraint violation (race condition)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`⚠️ Webhook event ${eventId} duplicate (race condition)`);
      return { isNew: false };
    }
    throw error;
  }
}

/**
 * Mark webhook event as processed.
 * Only sets processed=true on success (no error).
 * On failure, records the error but leaves processed=true so the
 * retry logic in logWebhookEvent can detect it as a failed attempt.
 */
export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { eventId },
    data: {
      processed: true,
      processedAt: new Date(),
      error: error || null,
    },
  });
}
