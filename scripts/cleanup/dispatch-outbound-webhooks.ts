/**
 * Outbound Webhook Dispatch Cron — Core Logic
 *
 * Drains the `OutboundWebhookDelivery` queue by invoking `runDispatchTick`
 * on a one-minute cadence. The worker handles signing, retries, and
 * status flips; this script is the thin "production" surface that
 * forwards to it and exposes the result.
 *
 * Imported by:
 *   - jobs/cleanup/dispatch-outbound-webhooks.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/dispatch-outbound-webhooks/route.ts (HTTP endpoint)
 *
 * Schedule: every minute via .github/workflows/dispatch-outbound-webhooks.yml.
 * The worker is idempotent (rows transition PENDING → IN_FLIGHT → SUCCESS
 * or RETRY) so a concurrent invocation simply observes the in-flight row
 * and skips it on the next tick.
 */

import prisma from "../../lib/prisma";
import { runDispatchTick } from "../../lib/enterprise/outbound-webhooks/worker";

export interface DispatchOutboundWebhooksResult {
  scanned: number;
  succeeded: number;
  retried: number;
  failed: number;
  success: boolean;
  errors: string[];
}

export async function dispatchOutboundWebhooks(): Promise<DispatchOutboundWebhooksResult> {
  const tick = await runDispatchTick({ prisma });
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
