/**
 * Stream Video Webhook Handler
 * Handles recording lifecycle and call session events from Stream
 *
 * Recording Events:
 * - call.recording_started
 * - call.recording_stopped
 * - call.recording_ready
 * - call.recording_failed
 *
 * Session Events:
 * - call.session_ended
 * - call.ended
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import {
  handleRecordingStarted,
  handleRecordingStopped,
  handleRecordingReady,
  handleRecordingFailed,
  StreamRecordingStartedEvent,
  StreamRecordingStoppedEvent,
  StreamRecordingReadyEvent,
  StreamRecordingFailedEvent,
} from "@/lib/stream/recording-handlers";
import {
  handleSessionEnded,
  handleCallEnded,
  StreamSessionEndedEvent,
  StreamCallEndedEvent,
} from "@/lib/stream/session-handlers";
import { logWebhookEvent, markWebhookEventProcessed } from "../../webhooks/utils";

// Stream webhook event types we handle
const HANDLED_EVENT_TYPES = [
  // Recording events
  "call.recording_started",
  "call.recording_stopped",
  "call.recording_ready",
  "call.recording_failed",
  // Session events
  "call.session_ended",
  "call.ended",
] as const;

type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

// Base event schema
const streamBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string(),
  created_at: z.string(),
});

// Recording ready event schema
const streamRecordingReadySchema = streamBaseEventSchema.extend({
  type: z.literal("call.recording_ready"),
  call_recording: z.object({
    filename: z.string(),
    url: z.string(),
    start_time: z.string(),
    end_time: z.string(),
  }),
});

// Recording failed event schema
const streamRecordingFailedSchema = streamBaseEventSchema.extend({
  type: z.literal("call.recording_failed"),
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

// Recording started schema
const streamRecordingStartedSchema = streamBaseEventSchema.extend({
  type: z.literal("call.recording_started"),
  user: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
});

// Recording stopped schema
const streamRecordingStoppedSchema = streamBaseEventSchema.extend({
  type: z.literal("call.recording_stopped"),
});

// Session ended schema
const streamSessionEndedSchema = streamBaseEventSchema.extend({
  type: z.literal("call.session_ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
    })
    .optional(),
});

// Call ended schema
const streamCallEndedSchema = streamBaseEventSchema.extend({
  type: z.literal("call.ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
    })
    .optional(),
  ended_by_user_id: z.string().optional(),
});

/**
 * Verify Stream webhook signature using HMAC SHA256
 */
async function verifyStreamSignature(
  req: NextRequest,
  body: string,
  secret: string
): Promise<boolean> {
  const signature = req.headers.get("x-signature");

  if (!signature) {
    console.warn("No x-signature header found in Stream webhook request");
    return false;
  }

  try {
    // Stream uses HMAC SHA256 for signature verification
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error("Error verifying Stream webhook signature:", error);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.STREAM_WEBHOOK_SECRET;

  // Validate webhook secret is configured
  if (!secret) {
    console.error("STREAM_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  // Read request body
  const body = await req.text();

  // Verify signature
  const isValid = await verifyStreamSignature(req, body, secret);

  if (!isValid) {
    console.warn("Invalid Stream webhook signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const event = JSON.parse(body);

    // Parse base event to get type
    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    // Check if this is an event type we handle
    if (!HANDLED_EVENT_TYPES.includes(eventType as HandledEventType)) {
      console.log(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    // Generate unique event ID for idempotency
    const eventId = `stream_${eventType}_${baseEvent.call_cid}_${baseEvent.created_at}`;

    // Log webhook event (idempotency check)
    const { isNew } = await logWebhookEvent(
      "stream",
      eventId,
      eventType,
      event,
      req.headers.get("x-signature") || undefined
    );

    if (!isNew) {
      console.log(`Duplicate Stream webhook event ${eventId}, returning OK`);
      return NextResponse.json({ status: "ok", duplicate: true });
    }

    console.log(`Processing Stream webhook: ${eventType}`, {
      call_cid: baseEvent.call_cid,
      created_at: baseEvent.created_at,
    });

    let processingError: string | undefined;

    try {
      switch (eventType) {
        // Recording events
        case "call.recording_started": {
          const startedEvent = streamRecordingStartedSchema.parse(event);
          await handleRecordingStarted(startedEvent);
          break;
        }

        case "call.recording_stopped": {
          const stoppedEvent = streamRecordingStoppedSchema.parse(event);
          await handleRecordingStopped(stoppedEvent);
          break;
        }

        case "call.recording_ready": {
          const readyEvent = streamRecordingReadySchema.parse(event);
          await handleRecordingReady(readyEvent as StreamRecordingReadyEvent);
          break;
        }

        case "call.recording_failed": {
          const failedEvent = streamRecordingFailedSchema.parse(event);
          await handleRecordingFailed(failedEvent as StreamRecordingFailedEvent);
          break;
        }

        // Session events
        case "call.session_ended": {
          const sessionEndedEvent = streamSessionEndedSchema.parse(event);
          await handleSessionEnded(sessionEndedEvent as StreamSessionEndedEvent);
          break;
        }

        case "call.ended": {
          const callEndedEvent = streamCallEndedSchema.parse(event);
          await handleCallEnded(callEndedEvent as StreamCallEndedEvent);
          break;
        }

        default:
          console.log(`Unhandled Stream event type: ${eventType}`);
      }
    } catch (handlerError) {
      processingError =
        handlerError instanceof Error
          ? handlerError.message
          : String(handlerError);
      console.error(`Error processing ${eventType}:`, handlerError);
      throw handlerError;
    } finally {
      // Mark event as processed
      await markWebhookEventProcessed(eventId, processingError);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Stream webhook error:", error);

    // Return 200 to prevent retries for parsing errors
    // Stream will retry on 5xx errors
    if (error instanceof z.ZodError) {
      console.error("Stream webhook validation error:", error.errors);
      return NextResponse.json(
        { error: "Invalid event format", details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

/**
 * HEAD handler for webhook verification
 * Some webhook providers send a HEAD request to verify the endpoint
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
