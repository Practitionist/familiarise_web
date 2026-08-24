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
import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { streamLogger } from "@/lib/stream-logger";
import {
  HANDLED_EVENT_TYPES,
  processStreamEvent,
  recordStreamEventReceipt,
  streamBaseEventSchema,
} from "@/lib/stream/webhook-dispatch";

/**
 * Verify Stream webhook signature using HMAC SHA256
 */
async function verifyStreamSignature(
  req: NextRequest,
  body: string,
  secret: string,
): Promise<boolean> {
  const signature = req.headers.get("x-signature");

  if (!signature) {
    streamLogger.warn("No x-signature header found in Stream webhook request");
    return false;
  }

  try {
    // Stream uses HMAC SHA256 for signature verification
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // Constant-time comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.byteLength !== expectedBuffer.byteLength) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (error) {
    streamLogger.error("Error verifying Stream webhook signature", error);
    return false;
  }
}

/**
 * #1134 P0-5 — Stream signs webhooks with the **API secret**. There is no
 * separate "signing secret" field in their dashboard, so requiring a distinct
 * `STREAM_WEBHOOK_SECRET` meant this route 500'd on every delivery for as long
 * as it existed: 0 rows in WebhookEvent for provider='stream', 0
 * MeetingAttendance, and 1,663 MeetingSessions that never ended.
 *
 * The override is kept so the value can be rotated independently if Stream ever
 * ships one, but the API secret is the correct default rather than a fatal gap.
 */
function getWebhookSecret(): string | undefined {
  return process.env.STREAM_WEBHOOK_SECRET || process.env.STREAM_API_SECRET;
}

export async function POST(req: NextRequest) {
  const secret = getWebhookSecret();

  // Validate webhook secret is configured
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

  // Read request body
  const body = await req.text();

  // Verify signature
  const isValid = await verifyStreamSignature(req, body, secret);

  if (!isValid) {
    streamLogger.warn("Invalid Stream webhook signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // #1134 P1-2 — the DB health probe used to run here, on the request path, to
  // buy a 503 retry. That trade is bad on Stream's budget: six seconds per
  // request inside fifteen seconds total, then the event is dropped forever. A
  // probe plus an idempotency read plus the handler plus the mark does not fit
  // in six seconds on a cold Netlify instance — and this repo has already
  // measured ~30s of event-loop stall on instance boot.
  //
  // So: acknowledge first, process in after(). Durability comes from the
  // WebhookEvent row and the stuck-event sweeper (which now covers Stream), not
  // from a retry window we cannot fit inside.
  try {
    const event = JSON.parse(body);

    // Parse base event to get type
    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    // Check if this is an event type we handle
    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    // #1134 P1-9 — dedup key derived ONLY from HMAC-verified material.
    //
    // An earlier version preferred Stream's `X-Webhook-ID` header. That
    // header is convenient operationally but is NOT covered by the signature
    // (Stream signs the body only), so one captured `(body, signature)` pair
    // could be replayed under N invented header values and mint N distinct
    // dedup keys — N dispatches from one verified delivery. Razorpay made
    // exactly this trade in the opposite direction for the same reason
    // (razorpay/route.ts "dedup key derived only from signature-covered
    // material").
    //
    // Keying on sha256(body) instead:
    //   - Retries of one delivery redeliver byte-identical payloads → they
    //     collapse to one key (the property X-Webhook-ID was bought for).
    //   - Legitimately-different events differ somewhere in the body
    //     (participant ids, message ids, timestamps) → never collapsed, which
    //     fixes the old hand-rolled key's bug where two flags in the same
    //     second deduped to one and participant joined/left dropped the user
    //     id entirely.
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const eventId = `stream_${baseEvent.type}_${bodyHash}`;

    const signature = req.headers.get("x-signature") || undefined;

    // Persist BEFORE acknowledging, then process in after().
    //
    // The durability argument used to be circular: it said durability comes from
    // the WebhookEvent row and the sweeper, while the row itself was written
    // inside `after()` — on the non-durable side of the acknowledgement. If the
    // instance froze before `after()` ran, or the DB probe inside it returned
    // unhealthy, no row was ever written; Stream already had its 200 and would
    // never redeliver; and the sweeper can only re-drive rows that exist. Three
    // paths, all losing a first delivery silently.
    //
    // One indexed insert of an already-parsed body fits inside the six-second
    // per-request timeout where the full handler does not — which is the whole
    // reason the handler moved to `after()` in the first place. This keeps that
    // split and makes the sweeper's guarantee real.
    //
    // A failure here is the one case worth a non-2xx: nothing is recorded, so
    // Stream's redelivery is the only remaining chance.
    try {
      await recordStreamEventReceipt(eventId, eventType, event, signature);
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

    // Acknowledge now; do the work after the response is sent. Everything below
    // this point is off Stream's retry budget, and its durability now genuinely
    // comes from the row written above plus sweep-stuck-webhook-events.
    after(async () => {
      // `claimAlreadyHeld` because the receipt above created this row. Without
      // it, dispatch re-claims an id it already owns, sees its own IN-PROGRESS
      // row, and returns without handling anything — which left every event to
      // the sweeper, six to sixteen minutes later, instead of running inline.
      await processStreamEvent(
        event,
        eventType,
        eventId,
        signature,
        baseEvent,
        {
          claimAlreadyHeld: true,
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
