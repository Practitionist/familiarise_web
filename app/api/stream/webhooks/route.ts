/**
 * Stream Webhook Handler — verify and acknowledge only.
 *
 * #1134 P1-2 — Stream retries a failed delivery at most THREE times (two on a
 * network error) inside a FIFTEEN SECOND total budget, six seconds per attempt,
 * and then drops the event permanently. A DB health probe plus an idempotency read plus the handler plus
 * the completion mark does not fit in six seconds on a cold Netlify instance,
 * and this repo has already measured ~30s of event-loop stall on instance boot.
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
    Sentry.captureException(
      new Error("Stream webhook secret not configured"),
      { tags: { subsystem: "stream" }, level: "fatal" },
    );
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
  // buy a 503 retry. That trade is bad on Stream's budget: three attempts (two
  // on a network error) inside FIFTEEN SECONDS total, six seconds per attempt,
  // then the event is dropped forever. Tighter than an earlier draft of this
  // comment claimed — which makes acking first more necessary, not less. A probe plus an idempotency read plus the handler plus
  // the mark does not fit in six seconds on a cold Netlify instance — and this
  // repo has already measured ~30s of event-loop stall on instance boot.
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

    // #1134 P1-9 — prefer Stream's own `X-Webhook-ID`, which is documented as
    // stable across the retries of one delivery and unique between deliveries.
    // The hand-rolled key collapsed to `stream_<type>_chat_<created_at>` for
    // chat events, so two flags in the same second deduped to one; participant
    // joined/left omitted the user id entirely, so two people joining in the
    // same second collapsed into a single attendance write.
    const webhookId = req.headers.get("x-webhook-id");
    const eventId = webhookId
      ? `stream_${webhookId}`
      : // Fallback for a delivery without the header: include every field that
        // distinguishes two legitimately-different events.
        [
          "stream",
          eventType,
          baseEvent.call_cid ?? "chat",
          (event as { session_id?: string }).session_id ?? "",
          (event as { participant?: { user?: { id?: string } } }).participant
            ?.user?.id ?? "",
          (event as { user?: { id?: string } }).user?.id ?? "",
          (event as { message?: { id?: string } }).message?.id ?? "",
          baseEvent.created_at,
        ]
          .filter(Boolean)
          .join("_");

    const signature = req.headers.get("x-signature") || undefined;

    // Acknowledge now; do the work after the response is sent. Everything below
    // this point is off Stream's retry budget, and its durability comes from the
    // WebhookEvent row plus sweep-stuck-webhook-events.
    after(async () => {
      await processStreamEvent(event, eventType, eventId, signature, baseEvent);
    });

    return NextResponse.json({ status: "ok", accepted: true });
  } catch (error) {
    streamLogger.error("Stream webhook error", error);

    // A malformed body will never become well-formed, so 400 and stop the
    // retries rather than burning the budget on a permanent failure.
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
