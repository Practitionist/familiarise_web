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
import {
  getWebhookSecret,
  verifyStreamWebhookSignature,
} from "@/lib/stream/webhook-signature";
import { runAfterOrInline } from "@/lib/stream/run-after-or-inline";
import {
  markWebhookEventProcessed,
  type WebhookClaim,
} from "@/lib/webhooks/event-log";
import { captureThrottled } from "@/lib/observability/throttled-capture";

const gunzip = promisify(gunzipCb);

async function readSignedBody(req: NextRequest): Promise<string> {
  const raw = Buffer.from(await req.arrayBuffer());

  // RFC 1952 gzip magic number (0x1f 0x8b); Stream signs the uncompressed JSON body.
  const isGzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!isGzipped) return raw.toString("utf8");

  const decompressed = await gunzip(raw);
  streamLogger.debug("Decompressed a gzipped Stream webhook payload", {
    compressedBytes: raw.length,
    decompressedBytes: decompressed.length,
  });
  return decompressed.toString("utf8");
}

function verifyStreamSignature(
  req: NextRequest,
  body: string,
  secret: string,
): boolean {
  const signature = req.headers.get("x-signature");
  return verifyStreamWebhookSignature(body, signature, secret);
}

async function handleOutOfWindowDelivery(
  eventId: string,
  eventType: string,
  event: unknown,
  signature: string | undefined,
  tooOld: string,
): Promise<NextResponse> {
  try {
    const receipt = await recordStreamEventReceipt(
      eventId,
      eventType,
      event,
      signature,
    );
    if (receipt.isNew) {
      await markWebhookEventProcessed(eventId, tooOld, receipt.claim);
    } else {
      streamLogger.warn(
        "Out-of-window replay of an already-recorded delivery — leaving its row untouched",
        { eventId, eventType },
      );
    }
  } catch (persistError) {
    streamLogger.error(
      `Failed to persist out-of-window Stream event ${eventId}`,
      persistError,
    );
    return NextResponse.json(
      { error: "Could not record event" },
      { status: 503 },
    );
  }

  streamLogger.warn(
    `Refused an out-of-window Stream delivery: ${tooOld} (${eventType})`,
  );
  return NextResponse.json({
    status: "ok",
    accepted: false,
    reason: "replay_window",
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

  const body = await readSignedBody(req);

  const isValid = verifyStreamSignature(req, body, secret);

  if (!isValid) {
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

  try {
    const event = JSON.parse(body);

    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    // Stream call/recording payloads have no stable top-level delivery ID, so hash the raw body.
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const eventId = `stream_${baseEvent.type}_${bodyHash}`;

    const signature = req.headers.get("x-signature") || undefined;

    const createdAt = new Date(baseEvent.created_at);
    const tooOld = Number.isNaN(createdAt.getTime())
      ? "permanent: unparseable_created_at"
      : classifyStreamDeliveryAge(createdAt);
    if (tooOld) {
      return await handleOutOfWindowDelivery(
        eventId,
        eventType,
        event,
        signature,
        tooOld,
      );
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

    // Acknowledge inside Stream's 6s timeout and run heavy handler work in after().
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
    streamLogger.error("Stream webhook error", error);

    // A malformed body will never become well-formed, so 400 and stop the
    // retries rather than burning the budget on a permanent failure.
    //
    // `JSON.parse` throws SyntaxError, not ZodError, so genuinely malformed JSON
    // used to fall past this branch to the 500 below — and Stream then spent its
    // whole retry budget redelivering a body that could never parse.
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
}

/**
 * HEAD handler for webhook verification.
 * Some webhook providers send a HEAD request to check the endpoint is live.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
