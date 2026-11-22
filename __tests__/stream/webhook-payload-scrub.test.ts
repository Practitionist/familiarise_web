/**
 * @jest-environment node
 */

/**
 * The stored `WebhookEvent.payload` drops participant profile data, yet the
 * stuck-event sweeper can still re-drive a handler from it.
 */
const mockHandleSessionParticipantJoined = jest.fn();
const mockHandleCallEnded = jest.fn();
const mockHandleRecordingStarted = jest.fn();
const mockMarkProcessed = jest.fn();

jest.mock("../../lib/webhooks/event-log", () => ({
  logWebhookEvent: jest.fn(),
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
  handleRecordingStarted: (...a: unknown[]) => mockHandleRecordingStarted(...a),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: jest.fn(),
  handleRecordingFailed: jest.fn(),
}));
jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: jest.fn(),
  handleCallEnded: (...a: unknown[]) => mockHandleCallEnded(...a),
  handleSessionParticipantJoined: (...a: unknown[]) =>
    mockHandleSessionParticipantJoined(...a),
}));

import { scrubStreamEventForStorage } from "../../lib/stream/webhook-payload-scrub";
import { processStreamEvent } from "../../lib/stream/webhook-dispatch";

const PROFILE = {
  name: "Asha Verma",
  image: "https://cdn.example/asha.png",
  custom: { phone: "+91 98765 43210", organization_id: "org-1" },
};

const JOINED = {
  type: "call.session_participant_joined",
  call_cid: "default:occurrence-1",
  created_at: "2026-10-24T10:00:00.000Z",
  session_id: "sess-1",
  received_at: "2026-10-24T10:00:01.000Z",
  participant: {
    user_session_id: "us-1",
    role: "user",
    user: { id: "u1", ...PROFILE },
  },
  call: { id: "occurrence-1", type: "default", custom: { notes: "private" } },
};

const CALL_ENDED = {
  type: "call.ended",
  call_cid: "default:occurrence-1",
  created_at: "2026-10-24T10:30:00.000Z",
  reason: "ended_by_user",
  user: { id: "host-1", ...PROFILE },
  call: { id: "occurrence-1", type: "default", ended_by_user_id: "host-1" },
};

const RECORDING_STARTED = {
  type: "call.recording_started",
  call_cid: "default:occurrence-1",
  created_at: "2026-10-24T10:05:00.000Z",
  user: { id: "host-1", ...PROFILE },
};

beforeEach(() => jest.clearAllMocks());

describe("scrubStreamEventForStorage", () => {
  it.each([JOINED, CALL_ENDED, RECORDING_STARTED])(
    "drops profile names, images and custom data from $type",
    (event) => {
      const stored = JSON.stringify(
        scrubStreamEventForStorage(event.type, event),
      );
      expect(stored).not.toMatch(
        /Asha|asha\.png|98765|private|organization_id/,
      );
    },
  );

  it("keeps the ids, timestamps and reasons the handlers read", () => {
    // The join only reopens the room, so who joined is not kept at all.
    expect(scrubStreamEventForStorage(JOINED.type, JOINED)).toEqual({
      type: JOINED.type,
      call_cid: JOINED.call_cid,
      created_at: JOINED.created_at,
    });
    expect(
      scrubStreamEventForStorage(CALL_ENDED.type, CALL_ENDED),
    ).toMatchObject({
      reason: "ended_by_user",
      user: { id: "host-1" },
      call: { ended_by_user_id: "host-1" },
    });
  });

  it("falls back to the generic scrubber for a payload its schema rejects", () => {
    const stored = scrubStreamEventForStorage("call.ended", {
      type: "call.ended",
      user: { id: "u1", name: "Asha Verma" },
    });
    expect(JSON.stringify(stored)).not.toContain("Asha");
  });
});

describe("a scrubbed payload still drives the handlers (sweeper re-drive)", () => {
  it("re-drives participant-joined from the stored shape", async () => {
    const stored = scrubStreamEventForStorage(JOINED.type, JOINED);

    await processStreamEvent(
      stored,
      JOINED.type,
      "evt-1",
      { call_cid: JOINED.call_cid },
      { claimedAt: null },
    );

    expect(mockHandleSessionParticipantJoined).toHaveBeenCalledTimes(1);
    expect(mockHandleSessionParticipantJoined.mock.calls[0][0]).toEqual({
      type: JOINED.type,
      call_cid: JOINED.call_cid,
      created_at: JOINED.created_at,
    });
    expect(mockMarkProcessed).toHaveBeenCalledWith("evt-1", undefined, {
      claimedAt: null,
    });
  });

  it("re-drives call.ended with the ender id intact", async () => {
    const stored = scrubStreamEventForStorage(CALL_ENDED.type, CALL_ENDED);

    await processStreamEvent(
      stored,
      CALL_ENDED.type,
      "evt-2",
      { call_cid: CALL_ENDED.call_cid },
      { claimedAt: null },
    );

    expect(mockHandleCallEnded.mock.calls[0][0]).toMatchObject({
      reason: "ended_by_user",
      user: { id: "host-1" },
    });
  });

  it("re-drives recording-started with the starter id", async () => {
    const stored = scrubStreamEventForStorage(
      RECORDING_STARTED.type,
      RECORDING_STARTED,
    );

    await processStreamEvent(
      stored,
      RECORDING_STARTED.type,
      "evt-3",
      { call_cid: RECORDING_STARTED.call_cid },
      { claimedAt: null },
    );

    expect(mockHandleRecordingStarted.mock.calls[0][0]).toMatchObject({
      user: { id: "host-1" },
    });
  });
});
