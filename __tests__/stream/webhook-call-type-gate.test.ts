/**
 * @jest-environment node
 */

/**
 * #1830 §5 — every `livestream` webhook was silently dropped.
 *
 * `isOwnCallType` read `callTypeFromCid(cid) === STREAM_CALL_TYPE`, a
 * single-type comparison against `default`. The gate runs at the boundary of
 * `processStreamEvent`, BEFORE dispatch, and then calls
 * `markWebhookEventProcessed`. So for a webinar minted on Stream's built-in
 * `livestream` type:
 *
 *   - the route's `HANDLED_EVENT_TYPES` check passes (the events are generic
 *     `call.*`, and the webhook subscription is per-PRODUCT, not per-call-type)
 *   - the route answers 200 to Stream and writes the receipt
 *   - `isOwnCallType` refuses
 *   - the row is stamped DONE
 *
 * `call.recording_ready` therefore never reached `recording-handlers.ts`. No VOD
 * transfer, no `Recording` row, no attendee notification, no `MeetingAttendance`
 * — and nothing anywhere reported an error, because a row marked done is one the
 * sweeper will not re-drive. Issue #1830 §5 step 6 never mentions the gate.
 *
 * The gate is not decorative, though, and these tests pin BOTH halves of that:
 * it must accept the types we own, and it must still refuse a genuinely foreign
 * one. What it protects is that every handler resolves its row with
 * `call_cid.split(":")[1]`, DISCARDING the type half, and matches
 * `Meeting.streamCallId` on the bare id — so a call on an unowned type whose id
 * half collides with a real meeting writes to that meeting.
 */

const mockLogWebhookEvent = jest.fn();
const mockMarkProcessed = jest.fn();
const mockIsDbHealthy = jest.fn();

/** eventType -> the recording/session handler it must reach. */
const handlers: Record<string, jest.Mock> = {
  "call.recording_started": jest.fn(),
  "call.recording_stopped": jest.fn(),
  "call.recording_ready": jest.fn(),
  "call.recording_failed": jest.fn(),
  "call.session_ended": jest.fn(),
  "call.ended": jest.fn(),
  "call.session_participant_joined": jest.fn(),
  "call.session_participant_left": jest.fn(),
};

jest.mock("../../lib/webhooks/event-log", () => ({
  TERMINAL_ERROR_PREFIXES: jest.requireActual("../../lib/webhooks/event-log")
    .TERMINAL_ERROR_PREFIXES,
  logWebhookEvent: (...a: unknown[]) => mockLogWebhookEvent(...a),
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => mockIsDbHealthy(),
  permanentFailure: (reason: string) => `permanent: ${reason}`,
}));

// Relative paths, not the `@/` alias — the alias resolves to a different module
// instance here, so the mock silently does not bind and a failure looks like a
// bad fixture rather than a broken gate.
jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: (...a: unknown[]) =>
    handlers["call.recording_started"](...a),
  handleRecordingStopped: (...a: unknown[]) =>
    handlers["call.recording_stopped"](...a),
  handleRecordingReady: (...a: unknown[]) =>
    handlers["call.recording_ready"](...a),
  handleRecordingFailed: (...a: unknown[]) =>
    handlers["call.recording_failed"](...a),
}));

jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: (...a: unknown[]) => handlers["call.session_ended"](...a),
  handleCallEnded: (...a: unknown[]) => handlers["call.ended"](...a),
  handleSessionParticipantJoined: (...a: unknown[]) =>
    handlers["call.session_participant_joined"](...a),
  handleSessionParticipantLeft: (...a: unknown[]) =>
    handlers["call.session_participant_left"](...a),
}));

const warn = jest.fn();
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  HANDLED_EVENT_TYPES,
  OWNED_CALL_TYPES,
  processStreamEvent,
} from "../../lib/stream/webhook-dispatch";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

const CALL_ID = "webinar-2026-10-02";

/**
 * A payload that satisfies each event's schema, so a refusal can only be
 * attributed to the call-type gate and never to validation. Anything the suite
 * asserts reached a handler was therefore really dispatched.
 */
function payloadFor(
  eventType: string,
  callCid: string,
): Record<string, unknown> {
  const base = {
    type: eventType,
    call_cid: callCid,
    created_at: "2026-10-02T10:00:00.000Z",
  };
  switch (eventType) {
    case "call.recording_ready":
      return {
        ...base,
        call_recording: {
          filename: `${CALL_ID}-0.mp4`,
          url: "https://example.invalid/vod/0.mp4",
          start_time: "2026-10-02T09:00:00.000Z",
          end_time: "2026-10-02T10:00:00.000Z",
        },
      };
    case "call.recording_failed":
      return { ...base, error: { message: "disk", code: "500" } };
    case "call.recording_started":
      return { ...base, user: { id: "host_1", name: "A Host" } };
    case "call.ended":
      return {
        ...base,
        call: { id: CALL_ID, type: "livestream", created_by_user_id: "host_1" },
        ended_by_user_id: "host_1",
      };
    case "call.session_ended":
      return {
        ...base,
        call: { id: CALL_ID, type: "livestream", created_by_user_id: "host_1" },
      };
    default:
      // STR-4 participant shapes.
      return {
        ...base,
        session_id: "sess-1",
        duration_seconds: 61,
        participant: {
          user: { id: "attendee_1" },
          user_session_id: "usess-1",
          role: "call_member",
        },
      };
  }
}

/**
 * Drive one delivery the way the route does: the receipt is already written, so
 * the dispatcher runs with the claim held.
 */
async function deliver(
  eventType: string,
  callCid: string,
): Promise<{ completed: boolean; error?: unknown }> {
  const eventId = `stream_${eventType}_${callCid}`;
  await processStreamEvent(
    payloadFor(eventType, callCid),
    eventType,
    eventId,
    "sig",
    { call_cid: callCid },
    { claimAlreadyHeld: true },
  );
  const mark = mockMarkProcessed.mock.calls.find((c) => c[0] === eventId);
  return { completed: mark !== undefined, error: mark?.[1] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogWebhookEvent.mockResolvedValue({
    isNew: true,
    eventRecordId: "r1",
    claim: { claimedAt: null },
  });
  mockMarkProcessed.mockResolvedValue(undefined);
  mockIsDbHealthy.mockResolvedValue(true);
  for (const handler of Object.values(handlers))
    handler.mockResolvedValue(undefined);
});

describe("OWNED_CALL_TYPES is a set, and default is in it", () => {
  it("keeps the appointment call type owned", () => {
    expect(OWNED_CALL_TYPES.has(STREAM_CALL_TYPE)).toBe(true);
  });

  it("owns livestream, which is what a webinar broadcast runs on", () => {
    expect(OWNED_CALL_TYPES.has("livestream")).toBe(true);
  });

  it("still refuses the two types that are reachable and unused", () => {
    // `development` is Stream's sandbox and `audio_room` is a hold-the-line
    // room; neither is minted by this app and both are stripped of the reach
    // grants by scripts/stream/harden-unused-call-types.ts. Admitting either
    // would be admitting an event stream we deliberately cannot prevent.
    expect(OWNED_CALL_TYPES.has("development")).toBe(false);
    expect(OWNED_CALL_TYPES.has("audio_room")).toBe(false);
  });
});

describe("a livestream delivery reaches its handler for EVERY handled event", () => {
  it.each(HANDLED_EVENT_TYPES)("%s", async (eventType) => {
    const handler = handlers[eventType];
    expect(handler).toBeDefined();

    const { completed, error } = await deliver(
      eventType,
      `livestream:${CALL_ID}`,
    );

    // Dispatched. Before the fix the handler was never called: the boundary
    // gate refused, and the row was stamped done.
    expect(handler).toHaveBeenCalledTimes(1);
    // And the handler saw the type half still on the cid, exactly as on the
    // `default` path — the gate must not rewrite the payload.
    expect(handler.mock.calls[0][0].call_cid).toBe(`livestream:${CALL_ID}`);
    // Completed with no error, so nothing is queued for the sweeper either.
    expect(completed).toBe(true);
    expect(error).toBeUndefined();
  });

  it("covers all eight handled types, so no event is left unasserted", () => {
    expect([...HANDLED_EVENT_TYPES].sort()).toEqual(
      [
        "call.ended",
        "call.recording_failed",
        "call.recording_ready",
        "call.recording_started",
        "call.recording_stopped",
        "call.session_ended",
        "call.session_participant_joined",
        "call.session_participant_left",
      ].sort(),
    );
  });
});

describe("the pre-existing accepted shapes are unchanged", () => {
  it("still dispatches a default call", async () => {
    const { completed, error } = await deliver(
      "call.recording_ready",
      `default:${CALL_ID}`,
    );

    expect(handlers["call.recording_ready"]).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
    expect(error).toBeUndefined();
  });

  it("still dispatches a bare call id with no type prefix", async () => {
    // The historical shape of this value, and `callTypeFromCid` reads it as the
    // app default. Widening the gate must not have made it stricter.
    await deliver("call.ended", CALL_ID);

    expect(handlers["call.ended"]).toHaveBeenCalledTimes(1);
  });

  it("has no reachable path for the absent-cid branch today", async () => {
    // `isOwnCallType(undefined)` is true — chat-scoped events carry no
    // `call_cid` — but every handled event type builds on
    // `streamCallBaseEventSchema`, which REQUIRES one. So the branch is
    // unreachable from a handled event rather than a hole, and this pins that:
    // a handled type delivered with no cid is refused by its own schema,
    // terminally, and never dispatched.
    await processStreamEvent(
      { type: "call.ended", created_at: "2026-10-02T10:00:00.000Z" },
      "call.ended",
      "stream_no_cid",
      "sig",
      {},
      { claimAlreadyHeld: true },
    );

    expect(handlers["call.ended"]).not.toHaveBeenCalled();
    const [id, error] = mockMarkProcessed.mock.calls[0] as [string, string];
    expect(id).toBe("stream_no_cid");
    expect(error).toMatch(/^permanent: /);
    // Terminal, not a foreign-type refusal — the two gates are distinguishable
    // in the log, which is what makes a real drop triageable.
    expect(warn).not.toHaveBeenCalledWith(
      "Refused Stream webhook for a foreign call type",
      expect.anything(),
    );
  });
});

describe("a genuinely foreign call type is still refused", () => {
  it.each(["development", "audio_room", "some_type_we_never_configured"])(
    "refuses %s without dispatching, and says which types we own",
    async (type) => {
      const { completed, error } = await deliver(
        "call.recording_ready",
        `${type}:${CALL_ID}`,
      );

      // The injection the gate exists for: a call on a type we do not own whose
      // id half collides with a real Meeting.
      expect(handlers["call.recording_ready"]).not.toHaveBeenCalled();
      expect(completed).toBe(true);
      // No error stamped — the sweeper re-drives on error, and re-driving a
      // permanently-refused event 168 hours' worth is pure churn.
      expect(error).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Refused Stream webhook for a foreign call type",
        expect.objectContaining({
          callType: type,
          owned: [...OWNED_CALL_TYPES].sort(),
        }),
      );
    },
  );

  it("does not confuse an owned prefix with a longer foreign one", async () => {
    // `startsWith` would have admitted `livestream_evil:` and
    // `developmentx`. The set lookup is exact.
    await deliver("call.recording_ready", `livestream_evil:${CALL_ID}`);
    await deliver("call.recording_ready", `developmentx:${CALL_ID}`);

    expect(handlers["call.recording_ready"]).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reads the type from the FIRST colon, not the last", async () => {
    // Call ids are `slot-<uuid>`; a hand-made id containing a colon must not be
    // able to smuggle a foreign type into the second half.
    await deliver("call.recording_ready", `development:${CALL_ID}:default`);

    expect(handlers["call.recording_ready"]).not.toHaveBeenCalled();
  });

  it("still drops an unhandled type before it ever reaches a gate", async () => {
    // Ordering is unchanged and correct: there is nothing to dispatch to, so the
    // call type is not even a question. Recorded so a future reordering is a
    // deliberate act rather than a side effect.
    await deliver("call.live_started" as never, `livestream:${CALL_ID}`);

    expect(handlers["call.recording_ready"]).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
    );
    expect(warn).not.toHaveBeenCalledWith(
      "Refused Stream webhook for a foreign call type",
      expect.anything(),
    );
  });
});
