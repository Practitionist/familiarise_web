/**
 * @jest-environment node
 */

/**
 * #1280 — the webhook boundary must refuse call types this app does not use.
 *
 * Every handler resolves its row with `call_cid.split(":")[1]`, discarding the
 * type half. Tokens here are app-wide (`generateUserToken`, no `call_cids`
 * claim), so every signed-in user already holds one that works on every call
 * type in the app.
 *
 * So a user who could mint a call on a type this app does not own could
 * `getOrCreate` `<that-type>:slot-<id>`, record anything, and have Stream
 * deliver a genuine, correctly-signed `call.recording_ready` whose id half
 * collided with a real Meeting — binding their recording to someone else's
 * appointment. Signature verification cannot help: the event really is from
 * Stream.
 *
 * These tests fail without the guard.
 *
 * ## Changed in #1830 — `livestream` moved from refused to OWNED
 *
 * This suite used to assert that a `livestream` recording was refused. That
 * assertion was not a security decision; it was the accident being pinned.
 * Refusing it ran BEFORE dispatch and then stamped the `WebhookEvent` row
 * processed, so a webinar broadcast on `livestream` lost its VOD, its
 * `Recording` row, its notification and its `MeetingAttendance` — silently, and
 * unrecoverably, because a row marked done is one the sweeper will not re-drive.
 *
 * `livestream` is safe to own because it is unreachable by an end user:
 * `harden-unused-call-types.ts` strips `create-call` / `join-call` /
 * `start-recording` from every non-admin role on it, and `video_get_call_type`
 * on the live app confirms the plain `user` role holds none of them. So
 * admitting it re-opens no route by which a user could have minted the call in
 * the first place. `OWNED_CALL_TYPES` in `lib/stream/webhook-dispatch.ts` is now
 * the single definition; `webhook-call-type-gate.test.ts` carries the widened
 * end-to-end coverage.
 *
 * The docblock's earlier claim that "the plain `user` role holds `create-call`
 * on all three" is also stale: those grants were removed when the types were
 * hardened, which is verified live rather than assumed here.
 */

const mockLogWebhookEvent = jest.fn();
const mockMarkProcessed = jest.fn();
const mockHandleRecordingReady = jest.fn();
const mockHandleSessionParticipantJoined = jest.fn();

jest.mock("../../lib/webhooks/event-log", () => ({
  logWebhookEvent: (...a: unknown[]) => mockLogWebhookEvent(...a),
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => true,
  permanentFailure: (reason: string) => `permanent: ${reason}`,
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: jest.fn(),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: (...a: unknown[]) => mockHandleRecordingReady(...a),
  handleRecordingFailed: jest.fn(),
}));

jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: jest.fn(),
  handleCallEnded: jest.fn(),
  handleSessionParticipantJoined: (...a: unknown[]) =>
    mockHandleSessionParticipantJoined(...a),
  handleSessionParticipantLeft: jest.fn(),
}));

import { processStreamEvent } from "../../lib/stream/webhook-dispatch";

/**
 * The real signature is (event, eventType, eventId, signature, baseEvent, opts).
 * `baseEvent.call_cid` is passed SEPARATELY from the event body, and it is what
 * the guard reads — so a test that omits it proves nothing. An earlier draft of
 * this file called the function with three arguments; the refusal assertions
 * still went green, because dispatch bailed long before the guard ran.
 */
function dispatch(event: { type: string; call_cid: string }, eventId: string) {
  return processStreamEvent(event, event.type, eventId, "sig", {
    call_cid: event.call_cid,
  });
}

const RECORDING_READY = (callCid: string) => ({
  type: "call.recording_ready",
  call_cid: callCid,
  created_at: "2026-08-30T12:00:00.000Z",
  call_recording: {
    filename: "rec.mp4",
    url: "https://attacker.example/rec.mp4",
    start_time: "2026-08-30T11:00:00.000Z",
    end_time: "2026-08-30T11:30:00.000Z",
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLogWebhookEvent.mockResolvedValue({
    isNew: true,
    claim: { claimedAt: null },
  });
  mockMarkProcessed.mockResolvedValue(undefined);
});

describe("webhook call-type guard", () => {
  it("processes a recording_ready on the app's own call type", async () => {
    await dispatch(RECORDING_READY("default:slot-abc"), "evt-default");
    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
  });

  // #1830 — the type a webinar broadcast runs on. It was in this list, and
  // being in it is what silently destroyed the recording of every livestream
  // call. It is owned now; see the module docblock for why that is safe.
  it("processes a recording_ready on the livestream call type", async () => {
    await dispatch(RECORDING_READY("livestream:slot-abc"), "evt-livestream");
    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
  });

  // Only the two types we neither mint nor can be made to exist on.
  it.each(["development", "audio_room"])(
    "refuses a recording_ready minted on the %s call type",
    async (foreignType) => {
      await dispatch(
        RECORDING_READY(`${foreignType}:slot-abc`),
        `evt-${foreignType}`,
      );
      // The id half collides with a real Meeting; the type half is the
      // only thing that distinguishes this from a genuine event.
      expect(mockHandleRecordingReady).not.toHaveBeenCalled();
    },
  );

  it("refuses foreign-type session events, which feed attendance and refunds", async () => {
    await dispatch(
      {
        type: "call.session_participant_joined",
        call_cid: "development:slot-abc",
        created_at: "2026-08-30T12:00:00.000Z",
        session_id: "s1",
        participant: { user: { id: "u1" }, user_session_id: "us1" },
      } as never,
      "evt-joined-foreign",
    );
    expect(mockHandleSessionParticipantJoined).not.toHaveBeenCalled();
  });

  it("still marks a refused event processed, so the sweeper does not re-drive it forever", async () => {
    await dispatch(RECORDING_READY("development:slot-abc"), "evt-marked");
    expect(mockMarkProcessed).toHaveBeenCalledWith("evt-marked", undefined, {
      claimedAt: null,
    });
  });

  it("treats a bare id with no type prefix as the app's own type", async () => {
    await dispatch(RECORDING_READY("slot-abc"), "evt-bare");
    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
  });
});
