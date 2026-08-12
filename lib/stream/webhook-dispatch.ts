/**
 * Stream webhook event schemas and dispatch.
 *
 * #1134 P1-2 — lives here, not in the route, for one reason: the stuck-event
 * sweeper has to be able to re-drive a Stream event, and a Next route module
 * cannot export anything but its HTTP handlers. The route is now a thin
 * verify-and-acknowledge shell; this is where the work happens, and both the
 * route's `after()` and sweep-stuck-webhook-events call in here.
 */
import * as Sentry from "@sentry/nextjs";
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
} from "@/lib/webhooks/event-log";

export { HANDLED_EVENT_TYPES } from "@/lib/stream/webhook-events";


// Base event schema for all Stream webhook events
// call_cid is optional because chat moderation events don't include it
export const streamBaseEventSchema = z.object({
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
 * Process one verified Stream event.
 *
 * Called from the route's `after()` once the delivery has been acknowledged, and
 * again from sweep-stuck-webhook-events for anything that failed. It owns its own
 * idempotency (`logWebhookEvent`) and completion bookkeeping
 * (`markWebhookEventProcessed`), so both callers can invoke it blindly.
 *
 * It never throws. The response is already sent by the time it runs, so there is
 * nobody to signal — a handler failure is stamped on the WebhookEvent row and
 * the sweeper re-drives it.
 */
export async function processStreamEvent(
  event: unknown,
  eventType: string,
  eventId: string,
  signature: string | undefined,
  baseEvent: { call_cid?: string },
): Promise<void> {
  try {
    // The health probe moved here from the request path: it is a real signal
    // worth acting on, but not worth spending the acknowledgement budget on.
    if (!(await isDbHealthy())) {
      streamLogger.warn(
        `DB unhealthy — deferring Stream event ${eventId} to the sweeper`,
      );
      return;
    }

    const { isNew } = await logWebhookEvent(
      "stream",
      eventId,
      eventType,
      event,
      signature,
    );

    if (!isNew) {
      streamLogger.debug(`Duplicate Stream webhook event: ${eventId}`);
      return;
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
      Sentry.captureException(
        handlerError instanceof Error
          ? handlerError
          : new Error(String(handlerError)),
        { tags: { subsystem: "stream" } },
      );
      // Deliberately NOT rethrown. The response has already been sent, so there
      // is nothing to signal to Stream; the error is stamped on the row below
      // and the sweeper owns the retry.
    } finally {
      await markWebhookEventProcessed(eventId, processingError);
    }
  } catch (error) {
    // Reaching here means the bookkeeping itself failed, so there may be no row
    // for the sweeper to find. This is the one shape that can still lose an
    // event — page on it.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" }, level: "error" },
    );
    streamLogger.error(
      `Stream webhook bookkeeping failed for ${eventId} — event may be lost`,
      error,
    );
  }
}
