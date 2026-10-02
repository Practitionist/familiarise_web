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
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import { processStreamEvent } from "@/lib/stream/webhook-dispatch";
import type { RazorpayWebhookEnvelope } from "@/schemas/webhooks/razorpay";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { TERMINAL_ERROR_PREFIXES } from "@/lib/webhooks/event-log";

/**
 * The terminal marker written when a deferred event ages past the give-up cap.
 *
 * The prefix comes from TERMINAL_ERROR_PREFIXES so the writer and the selector
 * below cannot drift. They used to be two string literals kept in sync by a
 * comment asking the next editor to remember.
 */
/** #1356 6.2 — deferrals past this count are no longer plausible arrival races. */
const DEFER_ALERT_THRESHOLD = 5;
/** #1356 6.2 — an event unprocessed this long has missed every ordinary retry. */
const ALERT_AGE_HOURS = 1;

function giveUpReason(provider: string): string {
  return provider === "stream"
    ? "gave up: Stream event never became processable"
    : "gave up: payment never arrived";
}

export interface SweepResult {
  success: boolean;
  scanned: number;
  recovered: number;
  stillFailing: number;
  // #813 — re-driven but still DEFERRED (row left processed=false/error=null by
  // a defer-sentinel handler, e.g. refund-before-capture): will retry next sweep.
  deferred: number;
  // #813 — deferred events that aged past giveUpAfterHours and were terminally
  // capped (processed=true, error='gave up: …' — see giveUpReason).
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

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
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
        provider: { in: ["razorpay", "stream"] },
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
            `(oldest: ${aged[0].eventId} @ ${aged[0].receivedAt.toISOString()}) — ` +
            `these were orphaned by the removed lower-age floor.`,
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
      const claimed = await prisma.webhookEvent.updateMany({
        where: {
          eventId: ev.eventId,
          OR: [{ claimedAt: null }, { claimedAt: ev.claimedAt }],
        },
        data: { claimedAt: new Date() },
      });
      if (claimed.count === 0) {
        console.log(
          `⏭️ Skipping ${ev.eventId} — claimed by another driver since selection`,
        );
        continue;
      }
      passProgress++;

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
      if (ev.provider === "stream") {
        // Stream stores the whole event as the payload, so there is no envelope
        // to rebuild. processStreamEvent owns its own logWebhookEvent /
        // markWebhookEventProcessed bookkeeping, exactly like the Razorpay
        // dispatch below.
        const streamEvent = ev.payload as { call_cid?: string } | null;
        await processStreamEvent(
          ev.payload,
          ev.eventType,
          ev.eventId,
          undefined,
          { call_cid: streamEvent?.call_cid },
        );
      } else {
        // processRazorpayWebhookEvent catches handler errors and marks the row
        // processed (stamping error on failure) in its finally — so this both
        // re-runs the side-effects AND clears the stuck flag.
        await processRazorpayWebhookEvent(envelope, ev.eventType, ev.eventId);
      }
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
                // Provider-specific: this sweep now covers Stream as well as
                // Razorpay, and stamping a Stream session event "payment never
                // arrived" sends whoever reads the row looking for a payment
                // that was never involved.
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

    if (stuck.length < BATCH_SIZE || passProgress === 0) break;
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

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
