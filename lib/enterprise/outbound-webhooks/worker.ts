import * as Sentry from "@sentry/nextjs";
import type { PrismaLike } from "@/lib/prisma";
/**
 * Outbound webhook delivery worker.
 *
 * Drains `OutboundWebhookDelivery` rows whose status is PENDING (first
 * attempt) or RETRY (any subsequent attempt whose `nextRetryAt` is now
 * or earlier). One worker tick:
 *
 *   1. Picks up to `MAX_BATCH` rows ordered by `nextRetryAt ASC NULLS FIRST`.
 *   2. For each row, signs the body and POSTs to the endpoint URL with
 *      a 10-second timeout.
 *   3. Records the outcome:
 *        - 2xx → status=SUCCESS, deliveredAt=now, endpoint.lastSuccessAt
 *        - 4xx (except 408 / 429) → status=FAILED, no retry — receiver
 *          told us the request is malformed; retrying won't help.
 *        - 5xx / 408 / 429 / network error → status=RETRY with the next
 *          backoff slot, OR status=FAILED if we just used the last
 *          attempt (5).
 *
 * Backoff schedule
 * ----------------
 *   attempt 1 → 1 minute
 *   attempt 2 → 5 minutes
 *   attempt 3 → 30 minutes
 *   attempt 4 → 2 hours
 *   attempt 5 → 8 hours (last)
 *   attempt 6 → FAILED
 *
 * Total wall-clock window from first attempt to FAILED: ~10h 36m.
 * Pairs with the 9h replay window in `signing.ts` so a receiver can
 * still verify the last attempt's signature even when the worker has
 * been catching up.
 *
 * Why fire-and-forget instead of a proper queue (SQS / RabbitMQ)
 * --------------------------------------------------------------
 * The project runs on Netlify primary / Vercel fallback — neither
 * vendor offers a first-class queue without an extra paid tier. The
 * delivery table IS the queue: an indexed (status, nextRetryAt) walk
 * is plenty for the volume (<10k orgs × low single-digit webhook RPS).
 * When the volume justifies SQS, the swap-in is a single function:
 * everything else stays.
 */

import { randomInt } from "node:crypto";
import vm from "node:vm";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  SIGNATURE_HEADER,
  signPayload,
  WEBHOOK_ROTATION_GRACE_MS,
} from "./signing";
import { assertPublicUrl, resolvePublicUrl } from "./ssrf-guard";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

export const DELIVERY_ID_HEADER = "X-Familiarise-Delivery-Id";
export const EVENT_HEADER = "X-Familiarise-Event";

const NATIVE_FETCH = globalThis.fetch;
const UNDICI_DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

interface PinnedDispatcher {
  close?: () => Promise<void> | void;
  destroy?: () => void;
}

type PinnedLookupFn = (
  hostname: string,
  opts: unknown,
  cb: (err: Error | null, address: string, family: number) => void,
) => void;

type BuiltinUndiciAgentCtor = new (opts: {
  connect: { lookup: PinnedLookupFn };
}) => PinnedDispatcher;

type UndiciModule = { Agent: BuiltinUndiciAgentCtor };

function isUndiciAgentCtor(value: unknown): value is BuiltinUndiciAgentCtor {
  return typeof value === "function";
}

function extractGlobalDispatcherCtor(): BuiltinUndiciAgentCtor | undefined {
  const builtInDispatcher =
    Reflect.get(globalThis, UNDICI_DISPATCHER_SYMBOL) ??
    Reflect.get(vm.runInThisContext("globalThis"), UNDICI_DISPATCHER_SYMBOL);
  if (
    typeof builtInDispatcher === "object" &&
    builtInDispatcher !== null &&
    "constructor" in builtInDispatcher &&
    isUndiciAgentCtor(builtInDispatcher.constructor)
  ) {
    return builtInDispatcher.constructor;
  }
  return undefined;
}

async function resolveUndiciAgentCtor(): Promise<BuiltinUndiciAgentCtor> {
  const builtinUndici: Partial<UndiciModule> | undefined =
    process.getBuiltinModule("undici");
  if (builtinUndici && isUndiciAgentCtor(builtinUndici.Agent)) {
    return builtinUndici.Agent;
  }

  let ctor = extractGlobalDispatcherCtor();
  if (!ctor && typeof NATIVE_FETCH === "function") {
    const ac = new AbortController();
    ac.abort();
    await NATIVE_FETCH("http://localhost", { signal: ac.signal }).catch(
      () => undefined,
    );
    ctor = extractGlobalDispatcherCtor();
  }
  if (!ctor) {
    throw new Error("Built-in Undici Agent constructor unavailable");
  }
  return ctor;
}

async function createPinnedDispatcher(resolved: {
  address: string;
  family: 4 | 6;
}): Promise<PinnedDispatcher> {
  const lookup: PinnedLookupFn = (_hostname, _opts, cb) =>
    cb(null, resolved.address, resolved.family);
  const AgentCtor = await resolveUndiciAgentCtor();
  return new AgentCtor({ connect: { lookup } });
}

const MAX_BATCH = 50;
const REQUEST_TIMEOUT_MS = 4_500;
const CONCURRENCY_CHUNK_SIZE = 5;
const MAX_ATTEMPTS = 5;

export const ENDPOINT_AUTO_DISABLE_FAILURES = 25;

async function maybeAutoDisableEndpoint(
  prisma: PrismaLike,
  endpoint: { id: string; organizationId: string; url: string },
): Promise<void> {
  const flipped = await prisma.webhookEndpoint.updateMany({
    where: {
      id: endpoint.id,
      status: "ACTIVE",
      failureCount: { gte: ENDPOINT_AUTO_DISABLE_FAILURES },
    },
    data: { status: "DISABLED" },
  });
  if (flipped.count === 0) return;

  if (prisma.systemEvent) {
    await recordSystemEvent({
      db: prisma,
      organizationId: endpoint.organizationId,
      category: "WEBHOOK",
      severity: "WARN",
      message: `Webhook endpoint auto-disabled after ${ENDPOINT_AUTO_DISABLE_FAILURES} consecutive failures: ${endpoint.url}`,
      context: { endpointId: endpoint.id, url: endpoint.url },
    });
  }
  if (prisma.orgAuditLog) {
    await prisma.orgAuditLog.create({
      data: {
        organizationId: endpoint.organizationId,
        category: "WEBHOOK",
        action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_DELIVERY_FAILED,
        description: `Webhook endpoint auto-disabled after ${ENDPOINT_AUTO_DISABLE_FAILURES} consecutive failures: ${endpoint.url}`,
        details: {
          endpointId: endpoint.id,
          url: endpoint.url,
          autoDisabled: true,
          failureCount: ENDPOINT_AUTO_DISABLE_FAILURES,
        },
      },
    });
  }
}

const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;

/**
 * Backoff slots indexed directly by completed `attemptNumber` (`row.attempts + 1`).
 * Index 0 is unused padding so `BACKOFF_MS[1]` is 1 minute on the first retry.
 */
const BACKOFF_MS = [
  0,
  60_000, // attempt 1 → 1 min
  5 * 60_000, // attempt 2 → 5 min
  30 * 60_000, // attempt 3 → 30 min
  2 * 60 * 60_000, // attempt 4 → 2 h
  8 * 60 * 60_000, // attempt 5 → 8 h
] as const;

export interface WorkerRunResult {
  scanned: number;
  succeeded: number;
  retried: number;
  failed: number;
  errors: string[];
}

type DeadLetterSummary = {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  attempts: number;
  httpStatusCode: number | null;
  lastError: string;
};

type DeliveryEndpointInfo = {
  id: string;
  url: string;
  secret: string;
  status: string;
  organizationId: string;
  secretRotatedAt: Date | null;
  previousSecretHash: string | null;
};

type DeliveryRow = {
  id: string;
  eventType: string;
  payload: unknown;
  status: import("@prisma/client").DeliveryStatus;
  attempts: number;
  createdAt: Date;
  endpoint: DeliveryEndpointInfo;
};

async function closeDispatcher(dispatcher: PinnedDispatcher | undefined) {
  if (dispatcher?.close) {
    await Promise.resolve(dispatcher.close()).catch(() => {});
  } else if (dispatcher?.destroy) {
    dispatcher.destroy();
  }
}

async function executeWebhookHttpAttempt(args: {
  url: string;
  body: string;
  signature: string;
  deliveryId: string;
  eventType: string;
  fetchImpl: typeof fetch;
  hasCustomFetch: boolean;
  assertUrl: (url: string) => Promise<void>;
}): Promise<{ httpStatusCode?: number; networkError?: string }> {
  let dispatcher: PinnedDispatcher | undefined;
  try {
    if (args.hasCustomFetch) {
      await args.assertUrl(args.url);
    } else {
      const resolved = await resolvePublicUrl(args.url);
      dispatcher = await createPinnedDispatcher(resolved);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await args.fetchImpl(args.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: args.signature,
          [DELIVERY_ID_HEADER]: args.deliveryId,
          [EVENT_HEADER]: args.eventType,
          "User-Agent": "Familiarise-Webhooks/1.0",
        },
        body: args.body,
        signal: ac.signal,
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
      });
      await res.body?.cancel().catch(() => {});
      return { httpStatusCode: res.status };
    } finally {
      clearTimeout(timer);
      await closeDispatcher(dispatcher);
    }
  } catch (err) {
    return {
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function recordSucceededDelivery(args: {
  prisma: PrismaLike;
  row: DeliveryRow;
  httpStatusCode: number;
  signature: string;
  attemptNumber: number;
  nowDate: Date;
}): Promise<void> {
  await args.prisma.outboundWebhookDelivery.update({
    where: { id: args.row.id },
    data: {
      status: "SUCCESS",
      httpStatusCode: args.httpStatusCode,
      signature: args.signature,
      attempts: args.attemptNumber,
      deliveredAt: args.nowDate,
      lastError: null,
    },
  });
  await args.prisma.webhookEndpoint.update({
    where: { id: args.row.endpoint.id },
    data: { lastSuccessAt: args.nowDate, failureCount: 0 },
  });
}

async function recordTerminalFailureAudit(
  prisma: PrismaLike,
  row: DeliveryRow,
  description: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!prisma.orgAuditLog) return;
  await prisma.orgAuditLog.create({
    data: {
      organizationId: row.endpoint.organizationId,
      category: "WEBHOOK",
      action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_DELIVERY_FAILED,
      description,
      details,
    },
  });
}

async function recordRetryOrTerminalFailure(args: {
  prisma: PrismaLike;
  row: DeliveryRow;
  httpStatusCode?: number;
  networkError?: string;
  signature: string;
  attemptNumber: number;
  nowDate: Date;
  nowMs: number;
  hasCustomClock: boolean;
  deadLettered: DeadLetterSummary[];
}): Promise<"retried" | "failed"> {
  const {
    prisma,
    row,
    httpStatusCode,
    networkError,
    signature,
    attemptNumber,
  } = args;

  const isPermanentClientError =
    httpStatusCode !== undefined &&
    httpStatusCode >= 400 &&
    httpStatusCode < 500 &&
    httpStatusCode !== 408 &&
    httpStatusCode !== 429;

  if (isPermanentClientError) {
    await prisma.outboundWebhookDelivery.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        httpStatusCode,
        signature,
        attempts: attemptNumber,
        lastError: `Permanent client error: ${httpStatusCode}`,
      },
    });
    await prisma.webhookEndpoint.update({
      where: { id: row.endpoint.id },
      data: {
        lastFailureAt: args.nowDate,
        failureCount: { increment: 1 },
      },
    });
    await recordTerminalFailureAudit(
      prisma,
      row,
      `Webhook delivery permanently rejected with HTTP ${httpStatusCode}`,
      {
        deliveryId: row.id,
        endpointId: row.endpoint.id,
        eventType: row.eventType,
        httpStatusCode,
        attempts: attemptNumber,
      },
    );
    await maybeAutoDisableEndpoint(prisma, row.endpoint);
    return "failed";
  }

  if (attemptNumber >= MAX_ATTEMPTS) {
    const deadLetterError =
      networkError ??
      `Exhausted retries; last status ${httpStatusCode ?? "n/a"}`;
    const resolvedStatus = httpStatusCode ?? null;
    await prisma.outboundWebhookDelivery.update({
      where: { id: row.id },
      data: {
        status: "DEAD_LETTER",
        httpStatusCode: resolvedStatus,
        signature,
        attempts: attemptNumber,
        lastError: deadLetterError,
      },
    });
    await prisma.webhookEndpoint.update({
      where: { id: row.endpoint.id },
      data: {
        lastFailureAt: args.nowDate,
        failureCount: { increment: 1 },
      },
    });
    await recordTerminalFailureAudit(
      prisma,
      row,
      `Webhook delivery dead-lettered after ${attemptNumber} attempts`,
      {
        deliveryId: row.id,
        endpointId: row.endpoint.id,
        eventType: row.eventType,
        httpStatusCode: resolvedStatus,
        attempts: attemptNumber,
        lastError: deadLetterError,
      },
    );
    await maybeAutoDisableEndpoint(prisma, row.endpoint);
    args.deadLettered.push({
      deliveryId: row.id,
      endpointId: row.endpoint.id,
      eventType: row.eventType,
      attempts: attemptNumber,
      httpStatusCode: resolvedStatus,
      lastError: deadLetterError,
    });
    return "failed";
  }

  const baseBackoff =
    BACKOFF_MS[Math.min(attemptNumber, BACKOFF_MS.length - 1)];
  const jitter = args.hasCustomClock ? 1 : 0.85 + randomInt(0, 3001) / 10_000;
  const backoff = Math.round(baseBackoff * jitter);
  await prisma.outboundWebhookDelivery.update({
    where: { id: row.id },
    data: {
      status: "RETRY",
      httpStatusCode: httpStatusCode ?? null,
      signature,
      attempts: attemptNumber,
      nextRetryAt: new Date(args.nowMs + backoff),
      lastError: networkError ?? `Transient ${httpStatusCode ?? "network"}`,
    },
  });
  await prisma.webhookEndpoint.update({
    where: { id: row.endpoint.id },
    data: {
      lastFailureAt: args.nowDate,
    },
  });
  return "retried";
}

export async function runDispatchTick(params: {
  prisma: PrismaLike;
  fetchFn?: typeof fetch;
  now?: () => number;
  maxBatch?: number;
  assertUrlFn?: (url: string) => Promise<void>;
}): Promise<WorkerRunResult> {
  const { prisma } = params;
  const fetchImpl = params.fetchFn ?? globalThis.fetch;
  const assertUrl = params.assertUrlFn ?? assertPublicUrl;
  const now = params.now ?? (() => Date.now());
  const batchLimit = params.maxBatch ?? MAX_BATCH;

  Sentry.logger.info("webhook-worker: tick started");

  const result: WorkerRunResult = {
    scanned: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    errors: [],
  };

  const deadLettered: DeadLetterSummary[] = [];

  const nowDate = new Date(now());
  const inFlightStaleBefore = new Date(now() - IN_FLIGHT_STALE_MS);
  const dueRows = await prisma.outboundWebhookDelivery.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RETRY", nextRetryAt: { lte: nowDate } },
        { status: "IN_FLIGHT", updatedAt: { lt: inFlightStaleBefore } },
      ],
    },
    orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
    take: batchLimit,
    include: {
      endpoint: {
        select: {
          id: true,
          url: true,
          secret: true,
          status: true,
          organizationId: true,
          secretRotatedAt: true,
          previousSecretHash: true,
        },
      },
    },
  });

  async function processOneDelivery(row: DeliveryRow): Promise<void> {
    result.scanned += 1;
    if (row.endpoint.status !== "ACTIVE") {
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          lastError: `Endpoint is ${row.endpoint.status}; aborted delivery.`,
        },
      });
      result.failed += 1;
      return;
    }

    const claim = await prisma.outboundWebhookDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: "IN_FLIGHT" },
    });
    if (claim.count === 0) return;

    const currentNowMs = now();
    const body = JSON.stringify({
      id: row.id,
      type: row.eventType,
      createdAt: row.createdAt.toISOString(),
      data: row.payload,
    });
    const inRotationGrace = Boolean(
      row.endpoint.secretRotatedAt &&
      row.endpoint.previousSecretHash &&
      currentNowMs - row.endpoint.secretRotatedAt.getTime() <=
        WEBHOOK_ROTATION_GRACE_MS,
    );
    const signature = signPayload(
      row.endpoint.secret,
      body,
      Math.floor(currentNowMs / 1000),
      inRotationGrace ? row.endpoint.previousSecretHash : null,
    );
    const attemptNumber = row.attempts + 1;

    const { httpStatusCode, networkError } = await executeWebhookHttpAttempt({
      url: row.endpoint.url,
      body,
      signature,
      deliveryId: row.id,
      eventType: row.eventType,
      fetchImpl,
      hasCustomFetch: Boolean(params.fetchFn),
      assertUrl,
    });

    if (
      httpStatusCode !== undefined &&
      httpStatusCode >= 200 &&
      httpStatusCode < 300
    ) {
      await recordSucceededDelivery({
        prisma,
        row,
        httpStatusCode,
        signature,
        attemptNumber,
        nowDate,
      });
      result.succeeded += 1;
      return;
    }

    const failureOutcome = await recordRetryOrTerminalFailure({
      prisma,
      row,
      httpStatusCode,
      networkError,
      signature,
      attemptNumber,
      nowDate,
      nowMs: currentNowMs,
      hasCustomClock: Boolean(params.now),
      deadLettered,
    });
    if (failureOutcome === "retried") {
      result.retried += 1;
    } else {
      result.failed += 1;
    }
  }

  for (let i = 0; i < dueRows.length; i += CONCURRENCY_CHUNK_SIZE) {
    const chunk = dueRows.slice(i, i + CONCURRENCY_CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map((row) => processOneDelivery(row)),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        result.errors.push(
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        );
      }
    }
  }

  if (deadLettered.length > 0) {
    Sentry.captureException(
      new Error(
        `Webhook deliveries dead-lettered (${deadLettered.length}): ${deadLettered[0].lastError}`,
      ),
      {
        tags: { subsystem: "enterprise", component: "outbound-webhooks" },
        level: "warning",
        contexts: {
          delivery: deadLettered[0],
          batch: {
            count: deadLettered.length,
            deliveryIds: deadLettered.map((d) => d.deliveryId),
          },
        },
      },
    );
  }

  Sentry.logger.info("webhook-worker: tick finished", {
    scanned: result.scanned,
    succeeded: result.succeeded,
    retried: result.retried,
    failed: result.failed,
  });

  return result;
}
