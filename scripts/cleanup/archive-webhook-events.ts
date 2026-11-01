/** Weekly webhook retention: whole-batch DELETEs, each re-evaluating its own predicate. */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { yearsBefore } from "@/lib/cron/retention-cutoff";

/** DPDP Rule 8(3): processing logs are kept a calendar year, whatever the event's outcome. */
const WEBHOOK_EVENT_RETENTION_YEARS = 1;
const OUTBOUND_DELIVERY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** No batch starts after this; one overrunning statement still ends inside the 20 s ticker timeout. */
const START_BUDGET_MS = 16_000;
/** Rows per DELETE; the candidate read walks the `receivedAt` index. */
export const WEBHOOK_DELETE_BATCH = 2_000;

export function webhookEventRetentionCutoff(now: Date): Date {
  return yearsBefore(now.getTime(), WEBHOOK_EVENT_RETENTION_YEARS);
}

export function outboundDeliveryRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - OUTBOUND_DELIVERY_RETENTION_DAYS * DAY_MS);
}

/** Processed or failed events; a pending event (no error yet) still belongs to the sweeper. */
function webhookEventBatch(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM "WebhookEvent" WHERE "id" IN (
      SELECT "id" FROM "WebhookEvent"
      WHERE ("processed" OR "error" IS NOT NULL) AND "receivedAt" < ${cutoff}
      ORDER BY "receivedAt" LIMIT ${WEBHOOK_DELETE_BATCH})`;
}

function outboundDeliveryBatch(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM "OutboundWebhookDelivery" WHERE "id" IN (
      SELECT "id" FROM "OutboundWebhookDelivery"
      WHERE "status" IN ('SUCCESS', 'FAILED', 'DEAD_LETTER')
        AND "createdAt" < ${cutoff}
      ORDER BY "createdAt" LIMIT ${WEBHOOK_DELETE_BATCH})`;
}

function formatArchiveError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error) ?? "Unknown error";
}

export interface WebhookArchiveResult {
  success: boolean;
  webhookEventsDeleted: number;
  outboundDeliveriesDeleted: number;
  totalDeleted: number;
  errors: string[];
  timestamp: string;
  hasMore: boolean;
}

export interface WebhookArchiveOptions {
  startedAt?: number;
}

export async function archiveWebhookEvents(
  options: WebhookArchiveOptions = {},
): Promise<WebhookArchiveResult> {
  const startedAt = options.startedAt ?? Date.now();
  return withCronLock("archive-webhook-events", { failMode: "open" }, () =>
    archiveWebhookEventsUnlocked(startedAt),
  );
}

async function archiveWebhookEventsUnlocked(
  startedAt: number,
): Promise<WebhookArchiveResult> {
  const deadline = startedAt + START_BUDGET_MS;
  const now = new Date();
  const errors: string[] = [];

  /** Whole batches until one comes back short or the deadline passes; a failure keeps committed counts. */
  const drain = async (
    label: string,
    batch: Prisma.Sql,
  ): Promise<{ count: number; hasMore: boolean }> => {
    let count = 0;
    try {
      while (Date.now() < deadline) {
        const deleted = await prisma.$executeRaw(batch);
        count += deleted;
        if (deleted < WEBHOOK_DELETE_BATCH) return { count, hasMore: false };
      }
      return { count, hasMore: true };
    } catch (error) {
      const msg = `Failed to archive ${label}: ${formatArchiveError(error)}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
      return { count, hasMore: true };
    }
  };

  // Deliveries first, so a year-deep event backlog cannot starve the 30-day window.
  const deliveries = await drain(
    "terminal outbound webhook deliveries",
    outboundDeliveryBatch(outboundDeliveryRetentionCutoff(now)),
  );
  const events = await drain(
    "webhook events",
    webhookEventBatch(webhookEventRetentionCutoff(now)),
  );

  return {
    success: errors.length === 0,
    webhookEventsDeleted: events.count,
    outboundDeliveriesDeleted: deliveries.count,
    totalDeleted: events.count + deliveries.count,
    errors,
    timestamp: new Date().toISOString(),
    hasMore: deliveries.hasMore || events.hasMore,
  };
}
