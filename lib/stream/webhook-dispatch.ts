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
import {
  type WebhookClaim,
  logWebhookEvent,
  markWebhookEventProcessed,
  isDbHealthy,
  permanentFailure,
} from "@/lib/webhooks/event-log";

// Imported AND re-exported: a bare `export … from` creates no local binding,
// so the type and the guard below could not see it. #1141 moved the list into
// its own module so ensure-webhook-subscription.ts can read it too.
import { HANDLED_EVENT_TYPES } from "@/lib/stream/webhook-events";
import { STREAM_CALL_TYPE, callTypeFromCid } from "@/lib/stream/call-cid";
export { HANDLED_EVENT_TYPES };

/**
 * The one list. `processStreamEvent`'s switch is checked against this at compile
 * time via the `never` assertion in its default branch, so adding an entry here
 * without adding a case — or vice versa — fails `tsc` instead of silently
 * dropping the event at runtime. They were two independent lists before.
 */
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(t: string): t is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(t);
}

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

export const streamRecordingReadySchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_ready"),
  call_recording: z.object({
    filename: z.string(),
    url: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    session_id: z.string().optional(),
  }),
});

// Stream sends no error detail on a failed recording, only which egress failed.
export const streamRecordingFailedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_failed"),
  egress_id: z.string(),
  recording_type: z.string(),
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

export const streamCallEndedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
      ended_by_user_id: z.string().optional(),
    })
    .optional(),
  user: z.object({ id: z.string() }).passthrough().optional(),
  reason: z.string().optional(),
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
/**
 * Is this event for a call type this app actually uses?
 *
 * Every handler resolves its row with `call_cid.split(":")[1]`, discarding the
 * type half. The app only ever uses `default`, but the Stream app also carries
 * the built-in `livestream`, `audio_room` and `development` types, and on all
 * three the plain `user` role holds `create-call` — `development` grants it
 * `start-recording`, `start-transcription` and `start-broadcasting` outright.
 * Tokens here are app-wide (`generateUserToken`, no `call_cids`), so any
 * signed-in user holds one that works on them.
 *
 * That let a user who knew one of their own anchor slot ids call `getOrCreate`
 * on `development:occurrence-<id>`, record whatever they liked, and have Stream
 * deliver a genuine, correctly-signed `call.recording_ready` whose id half
 * collided with a real Meeting — binding their recording to someone
 * else's appointment. Signature checking is no defence: the event is authentic.
 * The same collision reached the session handlers, where injected participant
 * events feed attendance, which feeds no-show detection, which issues refunds.
 *
 * Checked once, at the boundary, so a type added later cannot reintroduce it by
 * forgetting one of the eight call sites.
 */
export const OWNED_CALL_TYPES = new Set([STREAM_CALL_TYPE, "livestream"]);

export function isOwnCallType(callCid: string | undefined): boolean {
  return !callCid || OWNED_CALL_TYPES.has(callTypeFromCid(callCid));
}

export {
  recordStreamEventReceipt,
  reclaimStaleProcessingWebhookEvent,
} from "@/lib/stream/webhook-receipt";

export const STREAM_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STREAM_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function classifyStreamDeliveryAge(
  createdAt: Date,
  now: number = Date.now(),
): string | null {
  const age = now - createdAt.getTime();
  if (age > STREAM_REPLAY_WINDOW_MS) {
    return `permanent: replay_window_exceeded (age ${Math.round(age / 3_600_000)}h)`;
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
    streamRecordingStartedSchema,
    handleRecordingStarted,
  ),
  "call.recording_stopped": entry(
    streamRecordingStoppedSchema,
    handleRecordingStopped,
  ),
  "call.recording_ready": entry(
    streamRecordingReadySchema,
    handleRecordingReady,
  ),
  "call.recording_failed": entry(
    streamRecordingFailedSchema,
    handleRecordingFailed,
  ),
  "call.session_ended": entry(streamSessionEndedSchema, (e) =>
    handleSessionEnded(e as StreamSessionEndedEvent),
  ),
  "call.ended": entry(streamCallEndedSchema, (e) =>
    handleCallEnded(e as StreamCallEndedEvent),
  ),
  "call.session_participant_joined": entry(
    streamSessionParticipantJoinedSchema,
    (e) =>
      handleSessionParticipantJoined(e as StreamSessionParticipantJoinedEvent),
  ),
  "call.session_participant_left": entry(
    streamSessionParticipantLeftSchema,
    (e) => handleSessionParticipantLeft(e as StreamSessionParticipantLeftEvent),
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
  } finally {
    if (processingError !== undefined) {
      await markWebhookEventFailed(eventId, processingError, claim);
    } else {
      await markWebhookEventProcessed(eventId, undefined, claim);
    }
  }
}

export async function processStreamEvent(
  event: unknown,
  eventType: string,
  eventId: string,
  signature: string | undefined,
  baseEvent: { call_cid?: string },
  opts: {
    claimAlreadyHeld?: boolean;
    claim?: WebhookClaim;
  } = {},
): Promise<void> {
  try {
    if (!opts.claim && !(await isDbHealthy())) {
      streamLogger.warn(
        `DB unhealthy — deferring Stream event ${eventId} to the sweeper`,
      );
      return;
    }

    let claim: WebhookClaim | undefined = opts.claim;
    if (!opts.claimAlreadyHeld) {
      const logged = await logWebhookEvent(
        "stream",
        eventId,
        eventType,
        event,
        signature,
      );

      if (!logged.isNew) {
        streamLogger.debug(`Duplicate Stream webhook event: ${eventId}`);
        return;
      }
      claim = logged.claim;
    }

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
