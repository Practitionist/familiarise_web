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

/**
 * The Stream video call types this app OWNS, i.e. whose webhooks it handles.
 *
 * `STREAM_CALL_TYPE` (`default`) is every appointment call. `livestream` is
 * Stream's built-in broadcast type and is the shape a webinar-with-a-VOD takes
 * once webinars graduate from "one call per slot" to "one broadcast with
 * attendance around it" — it is here so that the FIRST `call.recording_ready` on
 * a `livestream` call is not silently thrown away.
 *
 * ## Why the previous single-type gate was a bug, not a guard
 *
 * It read `callTypeFromCid(cid) === STREAM_CALL_TYPE`, so a `livestream`
 * delivery was refused at the boundary, its `WebhookEvent` row stamped
 * processed, and Stream told 200. The result: no VOD transfer, no `Recording`
 * row, no attendee notification, no `MeetingAttendance` — and no error
 * anywhere, because a row marked done is one the sweeper will not re-drive. The
 * customer who paid for the recording is the one who finds out.
 *
 * That was not a deliberate tightening. Nothing in `HANDLED_EVENT_TYPES` or in
 * `ensure-webhook-subscription.ts` was call-type-scoped; the subscription is
 * per-PRODUCT (`"video"`), and every event we handle is a generic `call.*`
 * event that Stream emits for EVERY call type. So the dispatcher and the
 * subscription already agreed, and this gate was the only thing disagreeing
 * with both — invisibly, from inside the module nobody reads when a webhook
 * "does not fire".
 *
 * ## Why this is safe TODAY
 *
 * Verified against the live app (`video_query_calls`, and `video_get_call_type`
 * for all four types on this Stream app):
 *
 *   1. Only `default` calls exist. Every sampled call — most recent first —
 *      is `default:`; no `livestream`, `audio_room` or `development` call has
 *      ever existed. So widening changes no current behaviour at all; it only
 *      stops a class of event being dropped on the day it first arrives.
 *   2. `livestream` cannot be *forged* by a user, which is the attack this gate
 *      exists for. Its `user` role holds NO `create-call`, NO `join-call` and no
 *      un-scoped `start-recording` — only `admin` / `global_admin` can mint one.
 *      `scripts/stream/harden-unused-call-types.ts` is what removed those
 *      grants, and it lists `livestream` among the types it hardens.
 *   3. The residual risk the gate still covers is the one grants cannot reach:
 *      every handler resolves its row with `call_cid.split(":")[1]`, DISCARDING
 *      the type half, and matches `Meeting.streamCallId` on the bare id. A call
 *      on ANY unowned type whose id half coincides with a real meeting would
 *      bind to it. So the set — not the comparison — is the control.
 *
 * `audio_room` and `development` stay OUT. `development` is Stream's sandbox:
 * nothing here should ever run a call on it, and excluding it costs nothing.
 * `audio_room` is a hold-the-line room this app has no use for. Add a type to
 * this set in the same commit that makes the app mint calls on it — and read
 * `scripts/stream/harden-unused-call-types.ts` first, because that script strips
 * the reach grants from every type it calls "unused" and will happily strip the
 * ones a newly-owned type needs.
 */
const LIVESTREAM_CALL_TYPE = "livestream";

export const OWNED_CALL_TYPES: ReadonlySet<string> = new Set([
  STREAM_CALL_TYPE,
  LIVESTREAM_CALL_TYPE,
]);

/**
 * Is this event for a call type this app actually uses?
 *
 * Every handler resolves its row with `call_cid.split(":")[1]`, discarding the
 * type half. Tokens here are app-wide (`generateUserToken`, no `call_cids`), so
 * any signed-in user holds one that works on every call type in the app; a call
 * minted on an unowned type can therefore deliver a genuine, correctly-signed
 * event whose id half collides with a real Meeting. Signature checking is no
 * defence — the event IS authentic. The same collision reaches the session
 * handlers, where injected participant events feed attendance, which feeds
 * no-show detection, which issues refunds.
 *
 * A bare id with no `:` prefix is accepted: `callTypeFromCid` reads it as the
 * app default, and that is the historical shape of this value.
 *
 * Checked once, at the boundary, so a type added later cannot reintroduce the
 * collision by forgetting one of the eight call sites.
 */
function isOwnCallType(callCid: string | undefined): boolean {
  if (!callCid) return true;
  return OWNED_CALL_TYPES.has(callTypeFromCid(callCid));
}

/**
 * Write the delivery down, and nothing else.
 *
 * Split out of `processStreamEvent` so the route can call it BEFORE it
 * acknowledges. Everything the sweeper needs to re-drive an event later is this
 * row; the handler work is what does not fit in Stream's six-second budget, not
 * the insert. Deliberately does no DB-health probe and no handler dispatch —
 * this is the part that must be cheap enough to run on the request path.
 *
 * #1829 — this used to return `void` and throw away the `logWebhookEvent`
 * result, which is the whole answer to "have I seen this before?". The route had
 * no choice but to call `processStreamEvent(..., { claimAlreadyHeld: true })`,
 * and `claimAlreadyHeld` exists precisely to SKIP the `isNew` check — because
 * the row was just created. So every duplicate delivery was acknowledged 200
 * and then fully re-dispatched: attendance rows re-upserted, recording rows
 * re-created, notifications re-staged. The dedup key and its `@unique`
 * constraint were both correct and both gated nothing.
 *
 * The result is returned now so the route can answer `!isNew` with 200 and skip
 * the `after()` entirely, and so the claim travels with the completion mark.
 *
 * Throws on failure. The caller turns that into a non-2xx so Stream redelivers,
 * which is correct precisely because nothing was recorded.
 */
export async function recordStreamEventReceipt(
  eventId: string,
  eventType: string,
  event: unknown,
  signature: string | undefined,
): Promise<{ isNew: boolean; claim: WebhookClaim }> {
  const logged = await logWebhookEvent(
    "stream",
    eventId,
    eventType,
    event,
    signature,
  );
  // A P2002 race inside `logWebhookEvent` resolves to `{ isNew: false }` with no
  // `claim`, because the losing writer has no fence of its own to finalise with.
  // That is a duplicate by every measure the caller cares about, so normalise
  // the shape here rather than making each caller handle a half-result.
  return { isNew: logged.isNew, claim: logged.claim ?? { claimedAt: null } };
}

/**
 * #1829 — how old a delivery's own `created_at` may be before we refuse to act
 * on it, and how far into the future a clock is allowed to sit.
 *
 * The dedup key is `sha256(body)`, which is derived from SIGNED material — that
 * is the property the key exists for, and it is why the key cannot be forged
 * from a captured delivery. It is not, by itself, a replay defence, and the
 * honest version of this file has to say so: a byte-identical body replayed
 * after the 30-day archive has collected its row mints a FRESH key and dispatches
 * again, under either scheme. So the freshness window below is the actual
 * replay defence, and the key is only the collapse mechanism for retries.
 *
 * Why it matters concretely. `call.session_participant_joined` takes the CREATE
 * branch of the `MeetingAttendance` upsert when no row exists, and stamps
 * `firstJoinedAt` from the event's own clock. A replayed old body therefore
 * writes an ancient `firstJoinedAt` — which is the input to the consultant
 * no-show classifier and to the "were you actually there" review gate. One
 * forged or stale delivery silently poisons attendance-derived money.
 *
 * The window is set far above Stream's delivery budget (6s per attempt, 15s
 * total, no backoff) so a genuinely retried event is never near it, and far
 * above the sweeper's cadence so the re-drive path is never blocked by it — a
 * row the sweeper selects is minutes old, not days. It deliberately does NOT
 * overlap the 168h give-up window: a row terminally capped at 168h is not
 * re-driven, so a body older than the window can only be arriving from outside
 * Stream's own machinery, which is the definition of a replay.
 */
export const STREAM_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Forward clock skew tolerated. NTP-grade hosts are within seconds of each other. */
export const STREAM_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Classify a delivery's age against the replay window.
 *
 * @returns `null` when the delivery is inside the window, or a stable reason
 * string when it is not. The reason is written to the `error` column so the row
 * is legible in the table, and it is prefixed so the sweeper's selector treats
 * it as terminal and never re-drives it.
 */
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
  "call.recording_ready": entry(streamRecordingReadySchema, (e) =>
    handleRecordingReady(e as StreamRecordingReadyEvent),
  ),
  "call.recording_failed": entry(streamRecordingFailedSchema, (e) =>
    handleRecordingFailed(e as StreamRecordingFailedEvent),
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
  opts: {
    /**
     * The caller already wrote the receipt and therefore owns the claim.
     *
     * The route does: it persists before acknowledging, then dispatches in
     * `after()`. Without this, that second call re-enters `logWebhookEvent` for
     * an id whose row it just created — a row in the IN-PROGRESS state, aged
     * milliseconds — and the staleness escape correctly refuses it as another
     * worker's in-flight work. `isNew` comes back false and dispatch returns
     * having done nothing. The sweeper still rescues it, so nothing is lost, but
     * every event waits a full sweep cycle instead of running inline.
     *
     * The sweeper passes nothing and claims normally, which is what makes the
     * concurrency guard meaningful for the caller that actually competes.
     */
    claimAlreadyHeld?: boolean;
    /**
     * #1829 — the claim the caller already holds on the row, when it took one
     * outside this function. The live route does (via
     * `recordStreamEventReceipt`, which returns `logWebhookEvent`'s result);
     * the sweeper does not, and claims normally below, which is what keeps the
     * concurrency guard meaningful for the caller that actually competes.
     *
     * Passing it is what makes `markWebhookEventProcessed` fenced. Without it
     * the completion write is unconditional, so a worker whose claim was taken
     * over by the staleness escape can stamp its result over the newer
     * worker's.
     */
    claim?: WebhookClaim;
  } = {},
): Promise<void> {
  try {
    // The health probe moved here from the request path: it is a real signal
    // worth acting on, but not worth spending the acknowledgement budget on.
    //
    // Returning here is now safe ONLY because the route persists the receipt
    // before acknowledging. It was not before: this branch returned without
    // writing anything, so a DB blip on a first delivery left no row, and
    // "deferring to the sweeper" deferred to a sweeper that had nothing to find.
    // The sweeper genuinely owns it now.
    if (!(await isDbHealthy())) {
      streamLogger.warn(
        `DB unhealthy — deferring Stream event ${eventId} to the sweeper`,
      );
      return;
    }

    // The live route's claim on the row; the sweeper holds its own and passes
    // none, so its completion stays unfenced.
    //
    // #1829 — the route now passes the claim it actually took in `opts.claim`
    // rather than leaving this `undefined` on the `claimAlreadyHeld` path. Both
    // callers were arriving here with no fence: the route's because
    // `claimAlreadyHeld` short-circuited the assignment, and the sweeper's
    // because it never claimed at all. So `markWebhookEventProcessed` took the
    // unfenced branch on every Stream event in the system, and a worker whose
    // claim had been taken over by the staleness escape could stamp a completion
    // over the newer worker's. The claim is now always in hand.
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

    let processingError: string | undefined;

    // Narrow here so the `never` in the default branch is a real exhaustiveness
    // proof rather than a cast. Both callers hand us a string off the wire, and
    // asserting `as never` in the default would have compiled unconditionally —
    // a check that reads as protection and verifies nothing.
    if (!isHandledEventType(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      await markWebhookEventProcessed(eventId, undefined, claim);
      return;
    }

    if (!isOwnCallType(baseEvent.call_cid)) {
      // `warn`, not `error`: a call type this app does not own cannot become
      // one it does, so this is a refusal of an event we will never handle —
      // the same shape as the unhandled-type branch above. It is still stamped
      // done, deliberately: the sweeper re-drives on ERROR, and re-driving a
      // permanently-refused event 168 hours' worth is pure churn. `owned` is in
      // the context so a report of this line names the accepted set.
      //
      // `isOwnCallType` accepts an absent cid, so by this branch it is present —
      // but the helper cannot narrow the field for the compiler, hence the
      // local.
      const foreignCid = baseEvent.call_cid ?? "";
      streamLogger.warn("Refused Stream webhook for a foreign call type", {
        eventId,
        eventType,
        call_cid: foreignCid,
        callType: callTypeFromCid(foreignCid),
        owned: [...OWNED_CALL_TYPES],
      });
      await markWebhookEventProcessed(eventId, undefined, claim);
      return;
    }

    // #1280 — one `safeParse` at a choke point, not eight `.parse()` calls.
    //
    // Each case used to `.parse()` its own payload. A ZodError landed in the
    // handler catch below, was stamped on the row as an ordinary failure, and
    // the sweeper then re-drove it every ten minutes for its 168-hour give-up
    // window — roughly a thousand attempts at a payload that cannot become
    // valid. Schema mismatch is not a transient failure; treating it as one
    // burns the sweeper's budget on a row no retry can help while hiding a real
    // contract break behind noise that ages out on its own.
    //
    // Parsing in one place also means adding an event type cannot reintroduce a
    // bare `.parse()`: the schema comes from the table below, which the
    // exhaustiveness proof in `dispatch` keeps honest.
    const { schema, handle } = EVENT_HANDLERS[eventType];
    const parsed = schema.safeParse(event);

    if (!parsed.success) {
      // Terminal. `markWebhookEventProcessed` in the `finally` stamps this, and
      // the prefix keeps the sweeper away from it for good.
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      processingError = permanentFailure(
        `${eventType} payload does not match its schema — ${detail}`,
      );
      streamLogger.error(
        `Stream webhook ${eventId} is permanently unprocessable`,
        { eventType, detail },
      );
      // Paged, because a schema that stops matching means Stream changed a
      // contract we depend on. That is the opposite of the churn this replaces:
      // one alert with the field names in it, rather than a thousand silent
      // retries.
      Sentry.captureException(
        new Error(`Stream ${eventType} payload failed schema validation`),
        {
          tags: { subsystem: "stream", reason: "stream.schema_mismatch" },
          extra: { eventId, detail },
          level: "error",
        },
      );
      await markWebhookEventProcessed(eventId, processingError, claim);
      return;
    }

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
      // Deliberately NOT rethrown. The response has already been sent, so there
      // is nothing to signal to Stream; the error is stamped on the row below
      // and the sweeper owns the retry.
    } finally {
      await markWebhookEventProcessed(eventId, processingError, claim);
    }
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
