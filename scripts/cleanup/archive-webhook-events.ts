/**
 * Weekly webhook ledger & delivery pruning job.
 *
 * Retention policy:
 * - Processed `WebhookEvent` (`processed = true, error = null`): 30 days
 * - Terminal unreplayable `WebhookEvent` (`processed = false, error IS NOT NULL`): 30 days
 * - Failed / aged `WebhookEvent` (`processed = false, error IS NOT NULL`): 90 days
 * - `EmailEvent` delivery audit rows: 90 days
 * - Terminal `OutboundWebhookDelivery` (`SUCCESS`, `FAILED`, `DEAD_LETTER`): 30 days
 */

import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { TERMINAL_ERROR_PREFIXES } from "@/lib/webhooks/event-log";

const PROCESSED_RETENTION_DAYS = 30;
const FAILED_RETENTION_DAYS = 90;

function formatArchiveError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error) ?? "Unknown error";
}

export interface WebhookArchiveResult {
  success: boolean;
  processedEventsDeleted: number;
  terminalUnprocessedDeleted: number;
  failedEventsDeleted: number;
  emailEventsDeleted: number;
  outboundDeliveriesDeleted: number;
  totalDeleted: number;
  errors: string[];
  timestamp: string;
}

export async function archiveWebhookEvents(): Promise<WebhookArchiveResult> {
  return withCronLock("archive-webhook-events", { failMode: "open" }, () =>
    archiveWebhookEventsUnlocked(),
  );
}

async function archiveWebhookEventsUnlocked(): Promise<WebhookArchiveResult> {
  const errors: string[] = [];
  let processedEventsDeleted = 0;
  let terminalUnprocessedDeleted = 0;
  let failedEventsDeleted = 0;
  let emailEventsDeleted = 0;
  let outboundDeliveriesDeleted = 0;

  const processedRetention = new Date(
    Date.now() - PROCESSED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const failedRetention = new Date(
    Date.now() - FAILED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const runStep = async (
    label: string,
    fn: () => Promise<{ count: number }>,
  ): Promise<number> => {
    try {
      const res = await fn();
      return res.count;
    } catch (error) {
      const msg = `Failed to archive ${label}: ${formatArchiveError(error)}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
      return 0;
    }
  };

  processedEventsDeleted = await runStep("processed webhook events", () =>
    prisma.webhookEvent.deleteMany({
      where: {
        processed: true,
        error: null,
        receivedAt: { lt: processedRetention },
      },
    }),
  );

  terminalUnprocessedDeleted = await runStep(
    "terminal unprocessed webhook events",
    () =>
      prisma.webhookEvent.deleteMany({
        where: {
          processed: false,
          receivedAt: { lt: processedRetention },
          OR: TERMINAL_ERROR_PREFIXES.map((prefix) => ({
            error: { startsWith: prefix },
          })),
        },
      }),
  );

  failedEventsDeleted = await runStep("aged failed webhook events", () =>
    prisma.webhookEvent.deleteMany({
      where: {
        processed: false,
        error: { not: null },
        receivedAt: { lt: failedRetention },
      },
    }),
  );

  emailEventsDeleted = await runStep("aged email events", () =>
    prisma.emailEvent.deleteMany({
      where: {
        receivedAt: { lt: failedRetention },
      },
    }),
  );

  outboundDeliveriesDeleted = await runStep(
    "terminal outbound webhook deliveries",
    () =>
      prisma.outboundWebhookDelivery.deleteMany({
        where: {
          status: { in: ["SUCCESS", "FAILED", "DEAD_LETTER"] },
          createdAt: { lt: processedRetention },
        },
      }),
  );

  const totalDeleted =
    processedEventsDeleted +
    terminalUnprocessedDeleted +
    failedEventsDeleted +
    emailEventsDeleted +
    outboundDeliveriesDeleted;

  return {
    success: errors.length === 0,
    processedEventsDeleted,
    terminalUnprocessedDeleted,
    failedEventsDeleted,
    emailEventsDeleted,
    outboundDeliveriesDeleted,
    totalDeleted,
    errors,
    timestamp: new Date().toISOString(),
  };
}
