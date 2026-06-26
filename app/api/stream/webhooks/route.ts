/**
 * Stream Webhook Handler
 * Handles recording lifecycle, call session, and chat moderation events
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
 * - call.session_participant_joined
 * - call.session_participant_left
 *
 * Chat Moderation Events:
 * - user.flagged
 * - message.flagged
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { streamLogger } from "@/lib/stream-logger";
import {
  handleRecordingStarted,
  handleRecordingStopped,
  handleRecordingReady,
  handleRecordingFailed,
  StreamRecordingReadyEvent,
  StreamRecordingFailedEvent,
} from "@/lib/stream/recording-handlers";
import {
  handleSessionEnded,
  handleCallEnded,
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
  StreamSessionEndedEvent,
  StreamCallEndedEvent,
  StreamSessionParticipantJoinedEvent,
  StreamSessionParticipantLeftEvent,
} from "@/lib/stream/session-handlers";
import {
  handleUserFlagged,
  handleMessageFlagged,
  StreamUserFlaggedEvent,
  StreamMessageFlaggedEvent,
} from "@/lib/stream/chat-moderation-handlers";
import {
  logWebhookEvent,
  markWebhookEventProcessed,
  isDbHealthy,
} from "../../webhooks/utils";

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
  // STR-4 — per-attendee presence (unblocks #471 no-show / #472 overrun)
  "call.session_participant_joined",
  "call.session_participant_left",
  // Chat moderation events
  "user.flagged",
  "message.flagged",
] as const;

type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

// Base event schema for all Stream webhook events
// call_cid is optional because chat moderation events don't include it
const streamBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string().optional(),
  created_at: z.string(),
});

// Base schema for call/video events (call_cid required)
const streamCallBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string(),
  created_at: z.string(),
});

// Recording ready event schema
const streamRecordingReadySchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_ready"),
  call_recording: z.object({
    filename: z.string(),
    url: z.string(),
    start_time: z.string(),
    end_time: z.string(),
  }),
});

// Recording failed event schema
const streamRecordingFailedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_failed"),
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

// Recording started schema
const streamRecordingStartedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_started"),
  user: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
});

// Recording stopped schema
const streamRecordingStoppedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_stopped"),
});

// Session ended schema
const streamSessionEndedSchema = streamCallBaseEventSchema.extend({
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
const streamCallEndedSchema = streamCallBaseEventSchema.extend({
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

// STR-4 — participant joined/left. We only need the nested app user id
// (participant.user.id) + session_id; everything else is passed through loosely.
const streamParticipantSchema = z.object({
  user: z.object({ id: z.string() }),
  user_session_id: z.string().optional(),
  role: z.string().optional(),
});

const streamSessionParticipantJoinedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_joined"),
  session_id: z.string(),
  participant: streamParticipantSchema,
});

const streamSessionParticipantLeftSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_left"),
  session_id: z.string(),
  duration_seconds: z.number().optional(),
  participant: streamParticipantSchema,
});

// Chat moderation: user flagged schema
const streamUserFlaggedSchema = streamBaseEventSchema.extend({
  type: z.literal("user.flagged"),
  user: z.object({ id: z.string() }).optional(),
  target_user: z.object({ id: z.string() }).optional(),
});

// Chat moderation: message flagged schema
const streamMessageFlaggedSchema = streamBaseEventSchema.extend({
  type: z.literal("message.flagged"),
  user: z.object({ id: z.string() }).optional(),
  message: z
    .object({
      id: z.string(),
      text: z.string().optional(),
      user: z.object({ id: z.string() }).optional(),
    })
    .optional(),
});

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

export async function POST(req: NextRequest) {
  const secret = process.env.STREAM_WEBHOOK_SECRET;

  // Validate webhook secret is configured
  if (!secret) {
    streamLogger.error("STREAM_WEBHOOK_SECRET not configured");
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

  // DB health check — return 503 if DB is unreachable so Stream retries
  if (!(await isDbHealthy())) {
    streamLogger.warn("DB unhealthy — returning 503 for Stream retry");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  try {
    const event = JSON.parse(body);

    // Parse base event to get type
    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    // Check if this is an event type we handle
    if (!HANDLED_EVENT_TYPES.includes(eventType as HandledEventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    // Generate unique event ID for idempotency
    const eventId = `stream_${eventType}_${baseEvent.call_cid || "chat"}_${baseEvent.created_at}`;

    // Log webhook event (idempotency check)
    const { isNew } = await logWebhookEvent(
      "stream",
      eventId,
      eventType,
      event,
      req.headers.get("x-signature") || undefined,
    );

    if (!isNew) {
      streamLogger.debug(`Duplicate Stream webhook event: ${eventId}`);
      return NextResponse.json({ status: "ok", duplicate: true });
    }

    streamLogger.info(`Processing Stream webhook: ${eventType}`, {
      call_cid: baseEvent.call_cid || "chat",
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
          await handleRecordingFailed(
            failedEvent as StreamRecordingFailedEvent,
          );
          break;
        }

        // Session events
        case "call.session_ended": {
          const sessionEndedEvent = streamSessionEndedSchema.parse(event);
          await handleSessionEnded(
            sessionEndedEvent as StreamSessionEndedEvent,
          );
          break;
        }

        case "call.ended": {
          const callEndedEvent = streamCallEndedSchema.parse(event);
          await handleCallEnded(callEndedEvent as StreamCallEndedEvent);
          break;
        }

        // STR-4 — per-attendee presence
        case "call.session_participant_joined": {
          const joinedEvent =
            streamSessionParticipantJoinedSchema.parse(event);
          await handleSessionParticipantJoined(
            joinedEvent as StreamSessionParticipantJoinedEvent,
          );
          break;
        }

        case "call.session_participant_left": {
          const leftEvent = streamSessionParticipantLeftSchema.parse(event);
          await handleSessionParticipantLeft(
            leftEvent as StreamSessionParticipantLeftEvent,
          );
          break;
        }

        // Chat moderation events
        case "user.flagged": {
          const userFlaggedEvent = streamUserFlaggedSchema.parse(event);
          await handleUserFlagged(
            userFlaggedEvent as StreamUserFlaggedEvent,
          );
          break;
        }

        case "message.flagged": {
          const messageFlaggedEvent =
            streamMessageFlaggedSchema.parse(event);
          await handleMessageFlagged(
            messageFlaggedEvent as StreamMessageFlaggedEvent,
          );
          break;
        }

        default:
          streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      }
    } catch (handlerError) {
      processingError =
        handlerError instanceof Error
          ? handlerError.message
          : String(handlerError);
      streamLogger.error(`Error processing ${eventType}`, handlerError);
      Sentry.captureException(handlerError instanceof Error ? handlerError : new Error(String(handlerError)), { tags: { subsystem: "stream" } });
      throw handlerError;
    } finally {
      // Mark event as processed
      await markWebhookEventProcessed(eventId, processingError);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    streamLogger.error("Stream webhook error", error);

    // Return 200 to prevent retries for parsing errors
    // Stream will retry on 5xx errors
    if (error instanceof z.ZodError) {
      streamLogger.error("Stream webhook validation error", error);
      return NextResponse.json(
        { error: "Invalid event format", details: error.errors },
        { status: 400 },
      );
    }

    // Only capture here for errors that did NOT originate from the inner handler
    // (inner handler already calls captureException before rethrowing)
    // This covers JSON.parse failures, logWebhookEvent failures, etc.
    if (!(error instanceof Error && (error as { _sentryHandled?: boolean })._sentryHandled)) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    }

    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
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
