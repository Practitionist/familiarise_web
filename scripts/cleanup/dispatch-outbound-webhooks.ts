/**
 * Outbound Webhook Dispatch Cron — Core Logic
 *
 * Drains the `OutboundWebhookDelivery` queue by invoking `runDispatchTick`.
 * The worker handles signing, retries, and status flips; this script is the
 * thin "production" surface that forwards to it and exposes the result.
 *
 * Driven only by the Netlify ticker (netlify/functions/cron-tick.mts) via
 * app/api/cleanup/dispatch-outbound-webhooks/route.ts.
 * The worker is idempotent (rows transition PENDING → IN_FLIGHT → SUCCESS
 * or RETRY) so a concurrent invocation simply observes the in-flight row
 * and skips it on the next tick.
 */

import prisma from "../../lib/prisma";
import { runDispatchTick } from "../../lib/enterprise/outbound-webhooks/worker";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { recordSystemEvent } from "../../lib/enterprise/system-events";

// The delivery table IS the queue (see worker.ts). If overdue rows pile up
// past this, the worker isn't keeping pace — page someone (#776 §K).
const QUEUE_BACKLOG_THRESHOLD = 200;

async function checkQueueBacklog(): Promise<void> {
  const backlog = await prisma.outboundWebhookDelivery.count({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RETRY", nextRetryAt: { lte: new Date() } },
      ],
    },
  });
  if (backlog > QUEUE_BACKLOG_THRESHOLD) {
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message: `Outbound webhook queue backlog: ${backlog} deliveries due`,
      context: { backlog, threshold: QUEUE_BACKLOG_THRESHOLD },
    });
  }
}

export interface DispatchOutboundWebhooksResult {
  scanned: number;
  succeeded: number;
  retried: number;
  failed: number;
  success: boolean;
  errors: string[];
}

export interface DispatchOutboundWebhooksOptions {
  /** #1356 — forwarded as `runDispatchTick`'s `maxBatch`; undefined keeps its
   * own MAX_BATCH default. */
  limit?: number;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function dispatchOutboundWebhooks(
  opts: DispatchOutboundWebhooksOptions = {},
): Promise<DispatchOutboundWebhooksResult> {
  return withCronLock("dispatch-outbound-webhooks", { failMode: "open" }, () =>
    dispatchOutboundWebhooksUnlocked(opts),
  );
}

async function dispatchOutboundWebhooksUnlocked(
  opts: DispatchOutboundWebhooksOptions = {},
): Promise<DispatchOutboundWebhooksResult> {
  const tick = await runDispatchTick({ prisma, maxBatch: opts.limit });
  await checkQueueBacklog();
  return {
    scanned: tick.scanned,
    succeeded: tick.succeeded,
    retried: tick.retried,
    failed: tick.failed,
    success: tick.errors.length === 0,
    errors: tick.errors,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
