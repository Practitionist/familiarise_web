/**
 * Shared webhook idempotency ledger and connectivity health probe.
 */
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";

export type WebhookClaim = { claimedAt: Date | null };

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toInputJson);
  }
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Prisma.InputJsonValue | null } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = v === null ? null : toInputJson(v);
    }
    return out;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return "";
}

/** Terminal error prefixes skipped by background retry sweeps. */
export const TERMINAL_ERROR_PREFIXES = ["gave up:", "permanent:"] as const;

/** Formats a permanent unprocessable error marker for `WebhookEvent.error`. */
export function permanentFailure(reason: string): string {
  return `permanent: ${reason}`;
}

/** Returns true when `error` carries a terminal prefix that must never be retried. */
export function isTerminalWebhookError(error: string | null): boolean {
  if (error === null) return false;
  return TERMINAL_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/**
 * Lightweight DB connectivity check so webhook handlers return 503 during outages.
 */
export async function isDbHealthy(): Promise<boolean> {
  try {
    await prisma.user.findFirst({ select: { id: true } });
    return true;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "webhooks",
      op: "isDbHealthy",
      expected: false,
    });
    return false;
  }
}

async function resolveExistingWebhookEvent(
  existing: {
    id: string;
    processed: boolean;
    error: string | null;
    claimedAt: Date | null;
    receivedAt: Date;
  },
  eventId: string,
  payload: unknown,
): Promise<{ isNew: boolean; eventRecordId?: string; claim?: WebhookClaim }> {
  if (existing.processed && existing.error === null) {
    console.log(
      `⚠️ Webhook event ${eventId} already processed successfully, skipping`,
    );
    return { isNew: false, eventRecordId: existing.id };
  }

  if (isTerminalWebhookError(existing.error)) {
    return { isNew: false, eventRecordId: existing.id };
  }

  if (existing.error !== null) {
    const claimedAt = new Date();
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        eventId,
        error: { not: null },
        processed: false,
        claimedAt: existing.claimedAt,
        NOT: TERMINAL_ERROR_PREFIXES.map((p) => ({
          error: { startsWith: p },
        })),
      },
      data: {
        processed: false,
        processedAt: null,
        error: null,
        claimedAt,
        payload: toInputJson(payload),
      },
    });
    if (claimed.count === 0) {
      console.log(
        `⚠️ Webhook event ${eventId} claimed by another worker, skipping`,
      );
      return { isNew: false, eventRecordId: existing.id };
    }
    console.log(
      `🔄 Webhook event ${eventId} previously failed, allowing retry`,
    );
    return {
      isNew: true,
      eventRecordId: existing.id,
      claim: { claimedAt },
    };
  }

  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const claimStamp = existing.claimedAt ?? existing.receivedAt;
  const age = Date.now() - new Date(claimStamp).getTime();
  if (age > STALE_THRESHOLD_MS) {
    const claimedAt = new Date();
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        eventId,
        processed: false,
        claimedAt: existing.claimedAt,
      },
      data: {
        processed: false,
        processedAt: null,
        error: null,
        claimedAt,
        payload: toInputJson(payload),
      },
    });
    if (claimed.count === 0) {
      console.log(
        `⚠️ Webhook event ${eventId} claimed by another worker, skipping`,
      );
      return { isNew: false, eventRecordId: existing.id };
    }
    console.log(
      `🔄 Webhook event ${eventId} stale (in-progress for ${Math.round(age / 1000)}s), allowing retry`,
    );
    return {
      isNew: true,
      eventRecordId: existing.id,
      claim: { claimedAt },
    };
  }

  console.log(
    `⚠️ Webhook event ${eventId} currently being processed, skipping`,
  );
  return { isNew: false, eventRecordId: existing.id };
}

/**
 * Records an inbound webhook delivery and claims execution rights atomically.
 * Concurrent workers facing active leases (< 5m) or unique violations receive `isNew: false`.
 */
export async function logWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<{ isNew: boolean; eventRecordId?: string; claim?: WebhookClaim }> {
  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      return resolveExistingWebhookEvent(existing, eventId, payload);
    }

    const event = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: toInputJson(payload),
        signature,
        processed: false,
      },
    });

    return { isNew: true, eventRecordId: event.id, claim: { claimedAt: null } };
  } catch (error) {
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
 * Closes out a webhook delivery attempt with a strictly advancing `claimedAt` stamp so completed
 * or errored rows can never match unclaimed stale-processing predicates or duplicate claims.
 */
export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
  claim?: WebhookClaim,
): Promise<void> {
  const hasError = error !== undefined;
  const nextClaimedAt = new Date(
    Math.max(Date.now(), (claim?.claimedAt?.getTime() ?? 0) + 1),
  );
  const data = {
    processed: !hasError,
    processedAt: hasError ? null : new Date(),
    claimedAt: nextClaimedAt,
    error: hasError ? error : null,
  };
  if (!claim) {
    await prisma.webhookEvent.update({ where: { eventId }, data });
    return;
  }
  const res = await prisma.webhookEvent.updateMany({
    where: { eventId, claimedAt: claim.claimedAt },
    data,
  });
  if (res.count === 0) {
    reportSentryMessage("Webhook completion fenced: claim was superseded", {
      subsystem: "webhooks",
      op: "markWebhookEventProcessed",
      expected: true,
      extra: { eventId, error: error ?? null },
    });
  }
}
