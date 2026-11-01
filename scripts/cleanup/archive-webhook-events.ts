/** Bounded webhook/delivery retention; final deletes recheck current eligibility. */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteBoundedPage } from "@/lib/cron/run-deadline";
import { TERMINAL_ERROR_PREFIXES } from "@/lib/webhooks/event-log";

/** DPDP Rule 8(3): processing logs are kept a year, whatever the event's outcome. */
const WEBHOOK_EVENT_RETENTION_DAYS = 365;
const OUTBOUND_DELIVERY_RETENTION_DAYS = 30;

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
  outboundDeliveriesDeleted: number;
  totalDeleted: number;
  errors: string[];
  timestamp: string;
  hasMore: boolean;
}

const archiveLimit = z.number().int().min(1).max(500).default(100);
const START_BUDGET_MS = 16_000;

export interface WebhookArchiveOptions {
  limit?: number;
  startedAt?: number;
}

export async function archiveWebhookEvents(
  options: WebhookArchiveOptions = {},
): Promise<WebhookArchiveResult> {
  const startedAt = options.startedAt ?? Date.now();
  return withCronLock("archive-webhook-events", { failMode: "open" }, () =>
    archiveWebhookEventsUnlocked(options.limit, startedAt),
  );
}

async function archiveWebhookEventsUnlocked(
  requestedLimit: number | undefined,
  startedAt: number,
): Promise<WebhookArchiveResult> {
  const limit = archiveLimit.parse(requestedLimit);
  const outOfTime = () => Date.now() >= startedAt + START_BUDGET_MS;
  let hasMore = false;
  const errors: string[] = [];
  let processedEventsDeleted = 0;
  let terminalUnprocessedDeleted = 0;
  let failedEventsDeleted = 0;
  let outboundDeliveriesDeleted = 0;

  const eventRetention = new Date(
    Date.now() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const deliveryRetention = new Date(
    Date.now() - OUTBOUND_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const runStep = async (
    label: string,
    pick: () => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
    remains: () => Promise<{ id: string } | null>,
  ): Promise<number> => {
    const page = await deleteBoundedPage({
      outOfTime,
      pick,
      remove,
      remains,
      onError: (error) => {
        const msg = `Failed to archive ${label}: ${formatArchiveError(error)}`;
        console.error(`❌ ${msg}`);
        errors.push(msg);
      },
    });
    hasMore ||= page.hasMore;
    return page.deleted;
  };
  const archiveEvents = (label: string, where: Prisma.WebhookEventWhereInput) =>
    runStep(
      label,
      () =>
        prisma.webhookEvent.findMany({
          where,
          select: { id: true },
          orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
          take: limit,
        }),
      (ids) =>
        prisma.webhookEvent.deleteMany({
          where: { ...where, id: { in: ids } },
        }),
      () => prisma.webhookEvent.findFirst({ where, select: { id: true } }),
    );

  processedEventsDeleted = await archiveEvents("processed webhook events", {
    processed: true,
    error: null,
    receivedAt: { lt: eventRetention },
  });
  terminalUnprocessedDeleted = await archiveEvents(
    "terminal unprocessed webhook events",
    {
      processed: false,
      receivedAt: { lt: eventRetention },
      OR: TERMINAL_ERROR_PREFIXES.map((prefix) => ({
        error: { startsWith: prefix },
      })),
    },
  );
  failedEventsDeleted = await archiveEvents("aged failed webhook events", {
    processed: false,
    error: { not: null },
    receivedAt: { lt: eventRetention },
  });
  const outboundWhere: Prisma.OutboundWebhookDeliveryWhereInput = {
    status: { in: ["SUCCESS", "FAILED", "DEAD_LETTER"] },
    createdAt: { lt: deliveryRetention },
  };
  outboundDeliveriesDeleted = await runStep(
    "terminal outbound webhook deliveries",
    () =>
      prisma.outboundWebhookDelivery.findMany({
        where: outboundWhere,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
      }),
    (ids) =>
      prisma.outboundWebhookDelivery.deleteMany({
        where: { ...outboundWhere, id: { in: ids } },
      }),
    () =>
      prisma.outboundWebhookDelivery.findFirst({
        where: outboundWhere,
        select: { id: true },
      }),
  );

  const totalDeleted =
    processedEventsDeleted +
    terminalUnprocessedDeleted +
    failedEventsDeleted +
    outboundDeliveriesDeleted;

  return {
    success: errors.length === 0,
    processedEventsDeleted,
    terminalUnprocessedDeleted,
    failedEventsDeleted,
    outboundDeliveriesDeleted,
    totalDeleted,
    errors,
    timestamp: new Date().toISOString(),
    hasMore,
  };
}
