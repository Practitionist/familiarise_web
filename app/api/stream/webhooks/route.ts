/**
 * Stream Webhook Handler — verify and acknowledge only.
 *
 * #1134 P1-2 — Stream gives a failed delivery a SIX SECOND per-request timeout
 * inside a FIFTEEN SECOND total budget, then drops the event permanently. The
 * attempt count is deliberately not asserted here: Stream's own documentation
 * contradicts itself, with the webhooks overview giving 3 attempts for
 * 408/429/5xx and 2 for network errors while their retries announcement says "a
 * maximum of five attempts, whichever comes first". Both agree on the budget,
 * and the budget is what this design turns on.
 *
 * A DB health probe plus an idempotency read plus the handler plus the
 * completion mark does not fit in six seconds on a cold Netlify instance, and
 * this repo has already measured ~30s of event-loop stall on instance boot.
 *
 * So this route does the two things that must happen synchronously — verify the
 * signature, and reject a body that can never be valid — then acknowledges and
 * hands off to `after()`. Everything else lives in lib/stream/webhook-dispatch,
 * which the stuck-event sweeper also drives; durability comes from the
 * WebhookEvent row, not from a retry window we cannot fit inside.
 *
 * Handled events are listed in HANDLED_EVENT_TYPES over in the dispatch module.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { streamLogger } from "@/lib/stream-logger";
import {
  HANDLED_EVENT_TYPES,
  classifyStreamDeliveryAge,
  processStreamEvent,
  recordStreamEventReceipt,
  streamBaseEventSchema,
} from "@/lib/stream/webhook-dispatch";
import { isIgnoredEventType } from "@/lib/stream/webhook-events";
import {
  MAX_WEBHOOK_COMPRESSED_BYTES,
  MAX_WEBHOOK_DECOMPRESSED_BYTES,
  getWebhookSecret,
  isValidStreamSignatureFormat,
  verifyStreamApiKeyHeader,
  verifyStreamWebhookSignature,
} from "@/lib/stream/webhook-signature";
import { runAfterOrInline } from "@/lib/stream/run-after-or-inline";
import type { WebhookClaim } from "@/lib/webhooks/event-log";
import { captureThrottled } from "@/lib/observability/throttled-capture";

const gunzip = promisify(gunzipCb);

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

function validatePreBodyHeaders(req: NextRequest): NextResponse | null {
  const signature = req.headers.get("x-signature");
  if (!isValidStreamSignatureFormat(signature)) {
    streamLogger.warn(
      "Rejected Stream webhook with missing or non-hex signature",
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (!verifyStreamApiKeyHeader(req.headers.get("x-api-key"))) {
    streamLogger.warn("Rejected Stream webhook with mismatched x-api-key");
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isFinite(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_WEBHOOK_COMPRESSED_BYTES
    ) {
      streamLogger.warn("Rejected oversized Stream webhook by Content-Length", {
        contentLengthHeader,
      });
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
  }

  return null;
}

async function readBoundedRawBody(req: NextRequest): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_WEBHOOK_COMPRESSED_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new PayloadTooLargeError(
            `Compressed webhook body exceeded ${MAX_WEBHOOK_COMPRESSED_BYTES} bytes`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

async function readSignedBody(req: NextRequest): Promise<string> {
  const raw = await readBoundedRawBody(req);
  const encoding = req.headers.get("content-encoding")?.toLowerCase();
  const isGzipped =
    encoding === "gzip" ||
    (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b);
  if (!isGzipped) return raw.toString("utf8");

  try {
    const decompressed = await gunzip(raw, {
      maxOutputLength: MAX_WEBHOOK_DECOMPRESSED_BYTES,
    });
    streamLogger.debug("Decompressed a gzipped Stream webhook payload", {
      compressedBytes: raw.length,
      decompressedBytes: decompressed.length,
    });
    return decompressed.toString("utf8");
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (
      code === "ERR_BUFFER_TOO_LARGE" ||
      (err instanceof Error && err.message.includes("maxOutputLength"))
    ) {
      throw new PayloadTooLargeError(
        `Decompressed Stream webhook exceeded ${MAX_WEBHOOK_DECOMPRESSED_BYTES} bytes`,
      );
    }
    throw err;
  }
}

function resolveStreamWebhookEventId(
  req: NextRequest,
  eventType: string,
  body: string,
): string {
  const webhookId = req.headers.get("x-webhook-id")?.trim();
  if (webhookId) return `stream_${webhookId}`;
  const sha256Hex = crypto.createHash("sha256").update(body).digest("hex");
  return `stream_${eventType}_${sha256Hex}`;
}

function handleOutOfWindowDelivery(
  eventId: string,
  eventType: string,
  reason: string,
): NextResponse {
  streamLogger.warn("Refused out-of-window Stream delivery", {
    eventId,
    eventType,
    reason,
  });
  return NextResponse.json({
    status: "ok",
    ignored: true,
    accepted: false,
    reason,
  });
}

export async function POST(req: NextRequest) {
  const secret = getWebhookSecret();

  if (!secret) {
    streamLogger.error(
      "Neither STREAM_WEBHOOK_SECRET nor STREAM_API_SECRET is configured — Stream webhooks cannot be verified",
    );
    Sentry.captureException(new Error("Stream webhook secret not configured"), {
      tags: { subsystem: "stream" },
      level: "fatal",
    });
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const headerRejection = validatePreBodyHeaders(req);
  if (headerRejection) return headerRejection;

  try {
    const body = await readSignedBody(req);
    const signature = req.headers.get("x-signature") || undefined;

    if (!verifyStreamWebhookSignature(body, signature, secret)) {
      captureThrottled(
        "stream:webhook-signature",
        "Stream webhook signature verification failed — deliveries are being dropped",
        {
          subsystem: "stream",
          level: "error",
          op: "webhook.signature",
          tags: { reason: "stream.signature_invalid" },
          extra: {
            hasOverride: Boolean(process.env.STREAM_WEBHOOK_SECRET),
          },
        },
      );
      streamLogger.warn("Invalid Stream webhook signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = JSON.parse(body);
    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    if (isIgnoredEventType(eventType)) {
      return NextResponse.json({ status: "ok", handled: false, ignored: true });
    }

    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    const eventId = resolveStreamWebhookEventId(req, eventType, body);

    const createdAt = new Date(baseEvent.created_at);
    const tooOld = Number.isNaN(createdAt.getTime())
      ? "permanent: unparseable_created_at"
      : classifyStreamDeliveryAge(createdAt);
    if (tooOld) {
      return handleOutOfWindowDelivery(eventId, eventType, tooOld);
    }

    // Persist the receipt before acknowledging so the sweeper can recover if after() is killed.
    let receipt: { isNew: boolean; claim: WebhookClaim };
    try {
      receipt = await recordStreamEventReceipt(
        eventId,
        eventType,
        event,
        signature,
      );
    } catch (persistError) {
      streamLogger.error(
        `Failed to persist Stream event ${eventId} before ack`,
        persistError,
      );
      Sentry.captureException(
        persistError instanceof Error
          ? persistError
          : new Error(String(persistError)),
        { tags: { subsystem: "stream" }, level: "error" },
      );
      return NextResponse.json(
        { error: "Could not record event" },
        { status: 503 },
      );
    }

    if (!receipt.isNew) {
      streamLogger.debug(`Duplicate Stream webhook delivery: ${eventId}`);
      return NextResponse.json({
        status: "ok",
        accepted: true,
        duplicate: true,
      });
    }

    await runAfterOrInline(async () => {
      await processStreamEvent(
        event,
        eventType,
        eventId,
        signature,
        baseEvent,
        {
          claimAlreadyHeld: true,
          claim: receipt.claim,
        },
      );
    });

    return NextResponse.json({ status: "ok", accepted: true });
  } catch (error) {
    return formatWebhookErrorResponse(error);
  }
}

function formatWebhookErrorResponse(error: unknown): NextResponse {
  if (error instanceof PayloadTooLargeError) {
    streamLogger.warn("Stream webhook exceeded payload size limit", {
      message: error.message,
    });
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  streamLogger.error("Stream webhook error", error);

  if (error instanceof SyntaxError) {
    streamLogger.error("Stream webhook received unparseable JSON", error);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (error instanceof z.ZodError) {
    streamLogger.error("Stream webhook validation error", error);
    return NextResponse.json(
      { error: "Invalid event format", details: error.errors },
      { status: 400 },
    );
  }

  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "stream" } },
  );

  return NextResponse.json(
    { error: "Webhook handler failed" },
    { status: 500 },
  );
}

export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
