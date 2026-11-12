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
import { handleUnreadMessageReminder } from "@/lib/stream/chat/unread-digest";
import {
  type WebhookClaim,
  markWebhookEventProcessed,
  permanentFailure,
} from "@/lib/webhooks/event-log";

// The list lives in a dependency-free module so the drift detector can read it too.
import {
  HANDLED_EVENT_TYPES,
  isHandledEventType,
} from "@/lib/stream/webhook-events";
import { errorMessageOf } from "@/lib/observability/report";
import { STREAM_CALL_TYPE, callTypeFromCid } from "@/lib/stream/call-cid";
import { STREAM_EVENT_SCHEMAS } from "@/schemas/webhooks/stream";
export {
  streamBaseEventSchema,
  streamCallEndedSchema,
  streamRecordingFailedSchema,
  streamRecordingReadySchema,
} from "@/schemas/webhooks/stream";
export { HANDLED_EVENT_TYPES, isHandledEventType };

/** `EVENT_HANDLERS` is checked against this list at compile time, so a type without a handler fails `tsc`. */
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/**
 * Is this event for a call type this app actually uses?
 *
 * Handlers resolve their row from the id half of `call_cid` and ignore the type
 * half, so an authentic event from a built-in type (`livestream`, `audio_room`,
 * `development`) whose id collides with a real Meeting would bind to it. Only
 * `default` is owned; the check runs once here so no handler can forget it.
 */
export const OWNED_CALL_TYPES = new Set([STREAM_CALL_TYPE]);

export function isOwnCallType(callCid: string | undefined): boolean {
  return !callCid || OWNED_CALL_TYPES.has(callTypeFromCid(callCid));
}

export { recordStreamEventReceipt } from "@/lib/stream/webhook-receipt";

export const STREAM_REPLAY_WINDOW_MS = 10 * 60 * 1000;
export const STREAM_CLOCK_SKEW_MS = 2 * 60 * 1000;

export function classifyStreamDeliveryAge(
  createdAt: Date,
  now: number = Date.now(),
): string | null {
  const age = now - createdAt.getTime();
  if (age > STREAM_REPLAY_WINDOW_MS) {
    return `permanent: replay_window_exceeded (age ${Math.round(age / 1000)}s)`;
  }
  if (age < -STREAM_CLOCK_SKEW_MS) {
    return `permanent: created_at_in_future (${Math.round(-age / 1000)}s ahead)`;
  }
  return null;
}

export async function markWebhookEventFailed(
  eventId: string,
  error: string,
  claim?: WebhookClaim,
): Promise<void> {
  await markWebhookEventProcessed(
    eventId,
    error || "unknown handler error",
    claim,
  );
}

/**
 * One entry per handled event type: the schema that validates the payload, and
 * the handler that consumes it.
 *
 * `entry()` exists so the pairing is type-checked at the definition site — the
 * handler's parameter has to be assignable from `z.infer<typeof schema>`, or
 * this does not compile. Where a handler's declared type is narrower than what
 * the schema infers, the cast is written here and only here, which is where the
 * eight `case` blocks were each doing it before.
 *
 * `satisfies Record<HandledEventType, …>` is the exhaustiveness proof: adding a
 * type to HANDLED_EVENT_TYPES without adding a row here fails `tsc`, exactly as
 * the `never` in the old default branch did.
 */
function entry<S extends z.ZodTypeAny>(
  schema: S,
  handle: (event: z.infer<S>) => Promise<void>,
): { schema: z.ZodTypeAny; handle: (event: unknown) => Promise<void> } {
  return { schema, handle: (event) => handle(event as z.infer<S>) };
}

const EVENT_HANDLERS = {
  "call.recording_started": entry(
    STREAM_EVENT_SCHEMAS["call.recording_started"],
    handleRecordingStarted,
  ),
  "call.recording_stopped": entry(
    STREAM_EVENT_SCHEMAS["call.recording_stopped"],
    handleRecordingStopped,
  ),
  "call.recording_ready": entry(
    STREAM_EVENT_SCHEMAS["call.recording_ready"],
    handleRecordingReady,
  ),
  "call.recording_failed": entry(
    STREAM_EVENT_SCHEMAS["call.recording_failed"],
    handleRecordingFailed,
  ),
  "call.session_ended": entry(STREAM_EVENT_SCHEMAS["call.session_ended"], (e) =>
    handleSessionEnded(e as StreamSessionEndedEvent),
  ),
  "call.ended": entry(STREAM_EVENT_SCHEMAS["call.ended"], (e) =>
    handleCallEnded(e as StreamCallEndedEvent),
  ),
  "call.session_participant_joined": entry(
    STREAM_EVENT_SCHEMAS["call.session_participant_joined"],
    (e) =>
      handleSessionParticipantJoined(e as StreamSessionParticipantJoinedEvent),
  ),
  "call.session_participant_left": entry(
    STREAM_EVENT_SCHEMAS["call.session_participant_left"],
    (e) => handleSessionParticipantLeft(e as StreamSessionParticipantLeftEvent),
  ),
  "user.unread_message_reminder": entry(
    STREAM_EVENT_SCHEMAS["user.unread_message_reminder"],
    handleUnreadMessageReminder,
  ),
} satisfies Record<
  HandledEventType,
  { schema: z.ZodTypeAny; handle: (event: unknown) => Promise<void> }
>;

async function executeValidatedStreamHandler(
  eventType: HandledEventType,
  eventId: string,
  event: unknown,
  claim: WebhookClaim | undefined,
): Promise<void> {
  const { schema, handle } = EVENT_HANDLERS[eventType];
  const parsed = schema.safeParse(event);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    const processingError = permanentFailure(
      `${eventType} payload does not match its schema — ${detail}`,
    );
    streamLogger.error(
      `Stream webhook ${eventId} is permanently unprocessable`,
      { eventType, detail },
    );
    Sentry.captureException(
      new Error(`Stream ${eventType} payload failed schema validation`),
      {
        tags: { subsystem: "stream", reason: "stream.schema_mismatch" },
        extra: { eventId, detail },
        level: "error",
      },
    );
    await markWebhookEventFailed(eventId, processingError, claim);
    return;
  }

  let processingError: string | undefined;
  try {
    await handle(parsed.data);
  } catch (handlerError) {
    processingError = errorMessageOf(handlerError);
    streamLogger.error(`Error processing ${eventType}`, handlerError);
    Sentry.captureException(
      handlerError instanceof Error
        ? handlerError
        : new Error(String(handlerError)),
      { tags: { subsystem: "stream" } },
    );
  } finally {
    if (processingError !== undefined) {
      await markWebhookEventFailed(eventId, processingError, claim);
    } else {
      await markWebhookEventProcessed(eventId, undefined, claim);
    }
  }
}

/**
 * Process one verified Stream event.
 *
 * Both callers (the route's `after()` and sweep-stuck-webhook-events) hold the
 * receipt's claim; completion is fenced on it (`markWebhookEventProcessed`).
 *
 * It never throws. The response is already sent by the time it runs, so there is
 * nobody to signal — a handler failure is stamped on the WebhookEvent row and
 * the sweeper re-drives it.
 */
export async function processStreamEvent(
  event: unknown,
  eventType: string,
  eventId: string,
  baseEvent: { call_cid?: string },
  claim: WebhookClaim,
): Promise<void> {
  try {
    streamLogger.info(`Processing Stream webhook: ${eventType}`, {
      call_cid: baseEvent.call_cid || "chat",
    });

    if (!isHandledEventType(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      await markWebhookEventProcessed(eventId, undefined, claim);
      return;
    }

    if (!isOwnCallType(baseEvent.call_cid)) {
      streamLogger.warn("Refused Stream webhook for a foreign call type", {
        eventId,
        eventType,
        call_cid: baseEvent.call_cid,
        expected: Array.from(OWNED_CALL_TYPES),
      });
      await markWebhookEventProcessed(eventId, undefined, claim);
      return;
    }

    await executeValidatedStreamHandler(eventType, eventId, event, claim);
  } catch (error) {
    // Reaching here means the bookkeeping itself failed. That used to be the one
    // shape that could still lose an event, because the row was written on this
    // side of the acknowledgement — if this threw, nothing existed for the
    // sweeper to find. The route now writes the receipt BEFORE acknowledging, so
    // the row is already there and the sweeper will re-drive it. Still paged on:
    // it means the completion bookkeeping is broken, which is worth knowing even
    // though the event itself is no longer at risk.
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
