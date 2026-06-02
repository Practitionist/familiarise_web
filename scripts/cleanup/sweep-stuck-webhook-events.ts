/**
 * B5 stuck-webhook sweeper (#785, task #10).
 *
 * The webhook routes return HTTP 200 synchronously BEFORE the `after()` callback
 * runs the money side-effects. If the process crashes mid-callback, the
 * WebhookEvent row is left `processed=false, error=null` and is NEVER re-driven —
 * Razorpay/Stripe stop retrying once they see the 200, and the 5-min staleness
 * window only fires on a redelivery that will never come. The result is the
 * highest-blast-radius zombie: PAID money with an ISSUED invoice, frozen ACCRUED
 * overages, uncredited wallet top-ups, frozen tentative appointments,
 * unpersisted chargebacks.
 *
 * This sweeper actively re-dispatches those stuck events through the SAME handler
 * routing the live route uses (processRazorpayWebhookEvent). The handlers are
 * idempotent (ledger idempotency keys + status guards), so a replay is safe:
 * it either completes the side-effects (recovered) or stamps the error
 * (surfaced for review) — either way the row is no longer stuck.
 */
import prisma from "@/lib/prisma";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import type { RazorpayWebhookEnvelope } from "@/schemas/webhooks/razorpay";

export interface SweepResult {
  success: boolean;
  scanned: number;
  recovered: number;
  stillFailing: number;
  errors: string[];
}

export interface SweepOptions {
  /** Skip events newer than this — avoids racing an in-flight after() callback. */
  staleMinutes?: number;
  /** Ignore events older than this — archive-webhook-events reaps the long-dead. */
  maxAgeHours?: number;
  limit?: number;
}

export async function sweepStuckWebhookEvents(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const staleMinutes = opts.staleMinutes ?? 6;
  const maxAgeHours = opts.maxAgeHours ?? 72;
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const staleBefore = new Date(now - staleMinutes * 60_000);
  const tooOld = new Date(now - maxAgeHours * 3_600_000);

  // Stuck = after() crashed before markWebhookEventProcessed ran. Only razorpay
  // for now (stripe dispatch not yet extracted — tracked separately).
  const stuck = await prisma.webhookEvent.findMany({
    where: {
      provider: "razorpay",
      processed: false,
      error: null,
      receivedAt: { lt: staleBefore, gte: tooOld },
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  const errors: string[] = [];
  let recovered = 0;
  let stillFailing = 0;

  for (const ev of stuck) {
    // WebhookEvent.payload stores only `event.payload`; the per-event schemas
    // also require the envelope's entity/account_id/contains/created_at, so
    // supply them — the handlers route on eventType + payload.* and never read
    // these. `contains` mirrors Razorpay (the payload's top-level entity keys).
    const payloadKeys = Object.keys(
      (ev.payload ?? {}) as Record<string, unknown>,
    );
    const envelope = {
      entity: "event",
      account_id: "swept",
      event: ev.eventType,
      contains: payloadKeys,
      created_at: Math.floor(ev.receivedAt.getTime() / 1000),
      payload: ev.payload,
    } as unknown as RazorpayWebhookEnvelope;

    try {
      // processRazorpayWebhookEvent catches handler errors and marks the row
      // processed (stamping error on failure) in its finally — so this both
      // re-runs the side-effects AND clears the stuck flag.
      await processRazorpayWebhookEvent(envelope, ev.eventType, ev.eventId);
      const after = await prisma.webhookEvent.findUnique({
        where: { eventId: ev.eventId },
        select: { error: true, processed: true },
      });
      if (after?.error) {
        stillFailing++;
        errors.push(`${ev.eventId}: ${after.error}`);
      } else {
        recovered++;
        console.log(`✅ Re-drove stuck webhook ${ev.eventId}`);
      }
    } catch (e) {
      stillFailing++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${ev.eventId}: ${msg}`);
      // The dispatch normally marks the row, but guard so a throw here can't
      // leave it stuck to be re-swept forever.
      await prisma.webhookEvent
        .update({
          where: { eventId: ev.eventId },
          data: { processed: true, error: `sweep-failed: ${msg}` },
        })
        .catch(() => {});
    }
  }

  return { success: true, scanned: stuck.length, recovered, stillFailing, errors };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
