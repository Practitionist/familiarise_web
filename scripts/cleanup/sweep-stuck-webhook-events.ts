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
  // #813 — re-driven but still DEFERRED (row left processed=false/error=null by
  // a defer-sentinel handler, e.g. refund-before-capture): will retry next sweep.
  deferred: number;
  // #813 — deferred events that aged past giveUpAfterHours and were terminally
  // capped (processed=true, error='gave up: payment never arrived').
  gaveUp: number;
  errors: string[];
}

export interface SweepOptions {
  /** Skip events newer than this — avoids racing an in-flight after() callback. */
  staleMinutes?: number;
  /**
   * #812: No longer a hard lower bound on the scan — kept only as the threshold
   * past which we WARN that a stuck event has aged out of the old 72h window.
   * Sweeping is still safe at any age (idempotency keys + status guards), and
   * the archive retains failed rows 90d, so a lower floor here orphaned events
   * stuck between 72h and 90d (no actor). Defaults to the old 72h.
   */
  maxAgeHours?: number;
  /**
   * #813 — terminal cap for events a defer-sentinel handler keeps deferring (the
   * awaited row never arrives, e.g. a refund whose payment was never captured).
   * Past this age the sweeper force-marks them processed so they stop churning.
   * Defaults to 168h (7 days).
   */
  giveUpAfterHours?: number;
  limit?: number;
}

export async function sweepStuckWebhookEvents(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const staleMinutes = opts.staleMinutes ?? 6;
  const warnAgeHours = opts.maxAgeHours ?? 72;
  const giveUpAfterHours = opts.giveUpAfterHours ?? 168;
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const staleBefore = new Date(now - staleMinutes * 60_000);
  const warnOlderThan = new Date(now - warnAgeHours * 3_600_000);
  const giveUpOlderThan = new Date(now - giveUpAfterHours * 3_600_000);

  // Stuck = after() crashed before markWebhookEventProcessed ran. Only razorpay
  // for now (stripe dispatch not yet extracted — tracked separately).
  // #812: No lower-age floor — events stuck between the old 72h floor and the
  // 90d archive window were left with no actor. Keep only the upper bound
  // (don't race in-flight after() callbacks via staleBefore); re-driving an old
  // event is safe (per-row idempotency keys + status guards).
  const stuck = await prisma.webhookEvent.findMany({
    where: {
      provider: "razorpay",
      processed: false,
      error: null,
      receivedAt: { lt: staleBefore },
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  // #812: Surface events that aged past the old 72h window — these are exactly
  // the rows the previous lower bound would have silently orphaned.
  const aged = stuck.filter((ev) => ev.receivedAt < warnOlderThan);
  if (aged.length > 0) {
    console.warn(
      `⚠️  Sweeping ${aged.length} stuck webhook event(s) older than ${warnAgeHours}h ` +
        `(oldest: ${aged[0].eventId} @ ${aged[0].receivedAt.toISOString()}) — ` +
        `these were orphaned by the removed lower-age floor.`,
    );
  }

  const errors: string[] = [];
  let recovered = 0;
  let stillFailing = 0;
  let deferred = 0;
  let gaveUp = 0;

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
      } else if (after && !after.processed) {
        // #813 — still the defer signature (processed=false/error=null): a
        // defer-sentinel handler left it for the next sweep. Terminally cap once
        // it ages past giveUpAfterHours so an unknown payment can't churn forever.
        if (ev.receivedAt < giveUpOlderThan) {
          await prisma.webhookEvent
            .update({
              where: { eventId: ev.eventId },
              data: {
                processed: true,
                error: "gave up: payment never arrived",
              },
            })
            .catch(() => {});
          gaveUp++;
          errors.push(`${ev.eventId}: gave up: payment never arrived`);
          console.warn(
            `🛑 Gave up on stuck webhook ${ev.eventId} (deferred since ${ev.receivedAt.toISOString()}, past ${giveUpAfterHours}h cap)`,
          );
        } else {
          deferred++;
          console.log(`⏳ Stuck webhook ${ev.eventId} still deferred — will retry`);
        }
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

  return {
    success: true,
    scanned: stuck.length,
    recovered,
    stillFailing,
    deferred,
    gaveUp,
    errors,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
