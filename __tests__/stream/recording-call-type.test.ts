/**
 * @jest-environment node
 */

/**
 * Two call types, and every recording/presence call site that used to assume
 * there was only one.
 *
 * The failure this file exists to prevent is not an exception and not a wrong
 * row. Stream answers a call on a type it does not hold with a 404, and every
 * layer above that reports it as something ordinary: `startRecording` returns
 * `{ success: false }`, the route reverts `isRecording` and shows an error. What
 * is left behind is a `recordingStartedAt` with no recording — exactly the
 * orphaned-session shape `scripts/stream/reconcile-orphaned-recordings.ts` exists
 * to repair, and it asks Stream on the same wrong type and concludes the call had
 * nothing recorded. So the whole loop is silent. Nothing pages; the webinar is
 * simply not recorded, and every retry repeats it.
 *
 * `Meeting.streamCallId` is the BARE id, which is why this is easy to get wrong
 * rather than hard: the value at every one of these call sites looks identical
 * for a consultation and a webinar, and nothing in it says which room it names.
 *
 * What is pinned:
 *
 *   - a persisted `Meeting.callType` wins, mis-cased values and all, and a value
 *     this app does not own is coerced to `default` rather than producing a CID
 *     on somebody else's call type (#1285's shape);
 *   - a bare id with no type supplied still answers `default`, so every call
 *     minted before `livestream` exists behaves exactly as it did;
 *   - the id half of a CID is never altered — a "call type fix" must not become
 *     a different call;
 *   - and the transfer service, which addresses the vendor on the DELETE path,
 *     reads the type off the `Meeting` it already selects rather than guessing.
 */

const mockVideoCall = jest.fn();
const mockStartRecording = jest.fn().mockResolvedValue({ duration: "1ms" });
const mockStopRecording = jest.fn().mockResolvedValue({ duration: "1ms" });
const mockListRecordings = jest.fn().mockResolvedValue({ recordings: [] });
const mockDeleteRecording = jest.fn().mockResolvedValue({});
const mockGetCallReport = jest.fn();
const mockRecordingUpdateMany = jest.fn();
const mockDeleteRecordingObject = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: jest.fn() },
    recording: {
      findUnique: jest.fn(),
      updateMany: (...a: unknown[]) => mockRecordingUpdateMany(...a),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    orgAuditLog: { create: jest.fn() },
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: {
      call: (...a: unknown[]) => {
        mockVideoCall(...a);
        return {
          startRecording: mockStartRecording,
          stopRecording: mockStopRecording,
          listRecordings: mockListRecordings,
          deleteRecording: mockDeleteRecording,
          getCallReport: mockGetCallReport,
        };
      },
    },
  }),
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  isStreamQuotaError: () => false,
}));

// The transfer service opens a storage client at module scope, and the delete
// path must be provably NOT the one that owns the bucket object.
jest.mock("../../lib/stream/recording-storage", () => ({
  RECORDINGS_BUCKET: "recordings",
  RECORDING_MAX_OBJECT_BYTES: 1024 * 1024,
  RECORDING_MIME_TYPES: ["video/mp4"],
  storageClient: { storage: { from: () => ({ upload: jest.fn() }) } },
  deleteRecordingObject: (...a: unknown[]) => mockDeleteRecordingObject(...a),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  supabase: { storage: {} },
  supabaseAdmin: { storage: {} },
  ensureBucketExists: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../../lib/prisma";
import {
  RecordingService,
  resolveRecordingCallType,
} from "../../lib/stream/recording-service";
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { getCallPresenceEvidence } from "../../lib/stream/call-presence";
import {
  ALL_CALL_TYPES,
  LIVESTREAM_CALL_TYPE,
  STREAM_CALL_TYPE,
  isKnownCallType,
} from "../../lib/stream/call-cid";

/** The two arguments the last `client.video.call(...)` was made with. */
const addressed = (): [string, string] => {
  const last = mockVideoCall.mock.calls.at(-1);
  if (!last) throw new Error("no Stream call was made");
  return [last[0] as string, last[1] as string];
};

/**
 * A 404 shaped exactly as `@stream-io/node-sdk` throws one: `StreamError(message,
 * metadata, code)` where `metadata.responseCode` is `response.status`, and there
 * is no `status` and no `statusCode` on the object at all.
 */
const streamError = (responseCode: number) =>
  Object.assign(new Error(`Stream error: ${responseCode}`), {
    metadata: { responseCode, responseHeaders: new Map() },
  });

const meetingFindUnique = prisma.meeting.findUnique as unknown as jest.Mock;
const recordingFindUnique = prisma.recording.findUnique as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockStartRecording.mockResolvedValue({ duration: "1ms" });
  mockStopRecording.mockResolvedValue({ duration: "1ms" });
  mockListRecordings.mockResolvedValue({ recordings: [] });
  mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteRecordingObject.mockResolvedValue({ success: true });
  recordingFindUnique.mockResolvedValue(null);
});

describe("resolveRecordingCallType", () => {
  it("prefers the type persisted on the row over anything the CID suggests", () => {
    // The row is the source of truth (see the schema comment on
    // `Meeting.callType`): a call's type is IMMUTABLE in Stream, so the type it
    // was minted on is the only type that will ever answer for it.
    expect(
      resolveRecordingCallType("livestream:occurrence-a", STREAM_CALL_TYPE),
    ).toBe(STREAM_CALL_TYPE);
    expect(
      resolveRecordingCallType("default:occurrence-a", LIVESTREAM_CALL_TYPE),
    ).toBe(LIVESTREAM_CALL_TYPE);
  });

  it("reads the type off a CID when no row is in hand", () => {
    expect(resolveRecordingCallType("livestream:occurrence-a")).toBe(
      LIVESTREAM_CALL_TYPE,
    );
    expect(resolveRecordingCallType("default:occurrence-a")).toBe(
      STREAM_CALL_TYPE,
    );
  });

  it("answers `default` for a bare id, so every pre-cutover call is unchanged", () => {
    // `Meeting.streamCallId` stores the bare id. This is the path every caller
    // that forgets to pass the row takes, so it has to keep the historical
    // answer: right for every consultation, subscription and trial, and the
    // reason this change is not a migration.
    expect(resolveRecordingCallType("occurrence-a")).toBe(STREAM_CALL_TYPE);
    expect(resolveRecordingCallType("occurrence-a", null)).toBe(
      STREAM_CALL_TYPE,
    );
    expect(resolveRecordingCallType("occurrence-a", "")).toBe(STREAM_CALL_TYPE);
  });

  it("recovers a broadcast whose value was mis-cased or padded", () => {
    // The forgiving direction is the right one here: `"Livestream"` is a row
    // whose author plainly meant the broadcast type, and coercing it to `default`
    // would silently downgrade a webinar to a full-mesh call.
    expect(resolveRecordingCallType("occurrence-a", "Livestream")).toBe(
      LIVESTREAM_CALL_TYPE,
    );
    expect(resolveRecordingCallType("occurrence-a", "  livestream  ")).toBe(
      LIVESTREAM_CALL_TYPE,
    );
  });

  it("never resolves to a call type this app does not mint on", () => {
    // The load-bearing safety property, and the reason the return type is
    // `KnownCallType` rather than `string`: a hand-edited row must not be able
    // to point a recording at somebody else's namespace.
    for (const hostile of [
      "audio_room",
      "development",
      "livestream:occurrence-a",
      ":",
      "not_a_type",
    ]) {
      expect(
        isKnownCallType(resolveRecordingCallType("occurrence-a", hostile)),
      ).toBe(true);
    }
    expect(resolveRecordingCallType("occurrence-a", "audio_room")).toBe(
      STREAM_CALL_TYPE,
    );
    // …and a foreign type on the CID is coerced inward too, rather than being
    // addressed as-is.
    expect(resolveRecordingCallType("audio_room:occurrence-a")).toBe(
      STREAM_CALL_TYPE,
    );
  });

  it("never widens a type it was handed to a stranger's namespace", () => {
    // Pinned as a set rather than case by case, because the property is the
    // FUNCTION's: every one of `ALL_CALL_TYPES` is reachable, and nothing outside
    // it ever is. A call type added later without adding it here would fail this,
    // which is the point.
    const reachable = new Set<string>();
    for (const type of ALL_CALL_TYPES) {
      reachable.add(resolveRecordingCallType(`occurrence-a`, type));
      reachable.add(resolveRecordingCallType(`${type}:occurrence-a`));
    }
    expect([...reachable].sort()).toEqual([...ALL_CALL_TYPES].sort());
  });
});

describe("a livestream recording is addressed on the livestream call", () => {
  // The regression, in the shape production hands these functions: a BARE
  // `streamCallId` that says nothing about which room it names, plus the row
  // that does.
  const BARE = "occurrence-ls-1";

  it("starts the recording on the room the row names", async () => {
    const result = await RecordingService.startRecording(
      BARE,
      "user-1",
      "livestream",
    );

    expect(result).toEqual({ success: true });
    // The whole assertion: not `default:occurrence-ls-1`, which is a call that
    // does not exist and would have 404'd into a silent no-recording.
    expect(addressed()).toEqual(["livestream", "occurrence-ls-1"]);
    expect(mockStartRecording).toHaveBeenCalledTimes(1);
  });

  it("stops it on the same room", async () => {
    await RecordingService.stopRecording(BARE, "livestream");

    expect(addressed()).toEqual(["livestream", "occurrence-ls-1"]);
    expect(mockStopRecording).toHaveBeenCalledTimes(1);
  });

  it("lists its recordings there — this is the orphan reconciler's only source", async () => {
    mockListRecordings.mockResolvedValue({
      recordings: [
        {
          filename: "f-1.m3u8",
          url: "https://example/f-1",
          start_time: new Date("2026-09-13T10:00:00Z"),
          end_time: new Date("2026-09-13T11:00:00Z"),
          session_id: "s-1",
        },
      ],
    });

    const listed = await RecordingService.getCallRecordingsFromStream(
      BARE,
      "livestream",
    );

    expect(addressed()).toEqual(["livestream", "occurrence-ls-1"]);
    expect(listed).toHaveLength(1);
  });

  it("forwards the session's own type through the shared sync writer", async () => {
    // `syncSessionRecordings` IS the orphan reconciler's writer, and it holds
    // the whole Meeting row. Re-deriving the type there instead of forwarding
    // it would be a second source of truth for the one value that must come from
    // the row.
    mockListRecordings.mockResolvedValue({ recordings: [] });

    await RecordingService.syncSessionRecordings(
      {
        id: "mt-1",
        streamCallId: BARE,
        callType: "livestream",
        occurrence: { appointment: null },
      },
      [],
    );

    expect(addressed()).toEqual(["livestream", "occurrence-ls-1"]);
  });

  it("still answers `default` for a 1:1 — the change is not a retyping", async () => {
    await RecordingService.startRecording("occurrence-11", "user-1", "default");

    expect(addressed()).toEqual(["default", "occurrence-11"]);
  });

  it("addresses a CID argument's own type when the caller passes no row", async () => {
    // The webhook-shaped input: Stream hands out the prefixed form. Reading it
    // here is what stops a prefixed `livestream` value being silently retyped.
    await RecordingService.stopRecording("livestream:occurrence-ls-2");

    expect(addressed()).toEqual(["livestream", "occurrence-ls-2"]);
  });

  it("never changes the id half of a CID", async () => {
    // A type fix must not become a different call. `toCallId` owns the split;
    // the type half is all that moves.
    await RecordingService.stopRecording(
      "livestream:occurrence-abc-def",
      LIVESTREAM_CALL_TYPE,
    );
    expect(addressed()).toEqual(["livestream", "occurrence-abc-def"]);
  });
});

describe("presence evidence is read off the row too", () => {
  const report = (unique: number) => ({
    report: { participants: { unique, max_concurrent: unique } },
  });

  it("resolves the type from the Meeting when the caller has only a bare id", async () => {
    // `Meeting.streamCallId` is UNIQUE, so one lookup answers it for a value of
    // unknown provenance — which is what a bare id is. Both current callers pass
    // exactly that.
    meetingFindUnique.mockResolvedValue({ callType: "livestream" });
    mockGetCallReport.mockResolvedValue(report(41));

    const evidence = await getCallPresenceEvidence("occurrence-ls-3");

    expect(addressed()).toEqual(["livestream", "occurrence-ls-3"]);
    expect(evidence).toEqual({ unique: 41, maxConcurrent: 41 });
    expect(meetingFindUnique).toHaveBeenCalledWith({
      where: { streamCallId: "occurrence-ls-3" },
      select: { callType: true },
    });
  });

  it("skips the lookup when the caller already holds the row", async () => {
    mockGetCallReport.mockResolvedValue(report(2));

    await getCallPresenceEvidence("occurrence-11", "default");

    expect(meetingFindUnique).not.toHaveBeenCalled();
    expect(addressed()).toEqual(["default", "occurrence-11"]);
  });

  it("falls back to the 1:1 type when the row is gone, and believes that", async () => {
    // No row means no type, and the only defensible guess is the type every call
    // minted before `livestream` is on. When that guess is WRONG — and for a
    // webinar it is — Stream 404s and the honest answer is `null`, which is the
    // fail-safe direction for a caller about to move money. What must never
    // happen is a fabricated `unique: 0`, because the no-show detector reads that
    // as "nobody attended" and refunds a consultant who was in the room.
    meetingFindUnique.mockResolvedValue(null);
    mockGetCallReport.mockRejectedValue(streamError(404));

    expect(await getCallPresenceEvidence("occurrence-gone")).toBeNull();
    expect(addressed()).toEqual(["default", "occurrence-gone"]);
  });

  it("refuses to ask a type this app does not mint on", async () => {
    meetingFindUnique.mockResolvedValue({ callType: "audio_room" });
    mockGetCallReport.mockResolvedValue(report(2));

    await getCallPresenceEvidence("occurrence-x");

    expect(addressed()).toEqual(["default", "occurrence-x"]);
  });
});

describe("the vendor-side delete is addressed on the row's call type too", () => {
  // `Recording.streamCallId` is BARE — the recording webhook writes
  // `toCallId(call_cid)` — so on this path the type is only reachable through the
  // Meeting. Getting it wrong is worse here than on the start path, because
  // `listRecordings` on the wrong type returns an EMPTY list rather than an
  // error, the target is not found, and the function returns TRUE: a deletion
  // reported as done that never happened, with the bytes still at the vendor
  // until Stream's own fourteen-day expiry.
  const row = (callType: string) => ({
    id: "rec-1",
    title: "Webinar replay",
    status: "AVAILABLE",
    storageType: "PLATFORM",
    storagePath: "recordings/2026/09/rec-1/recording.mp4",
    streamCallId: "occurrence-ls-9",
    streamRecordingId: "seg-0.m3u8",
    organizationId: null,
    meeting: { id: "mt-9", callType },
  });

  const listed = () => ({
    recordings: [{ filename: "seg-0.m3u8", session_id: "sess-9", url: "u" }],
  });

  it("lists and deletes against `livestream:` for a broadcast recording", async () => {
    recordingFindUnique.mockResolvedValue(row("livestream"));
    mockListRecordings.mockResolvedValue(listed());

    const result = await RecordingTransferService.deleteRecording("rec-1");

    expect(addressed()).toEqual(["livestream", "occurrence-ls-9"]);
    expect(mockDeleteRecording).toHaveBeenCalledWith({
      session: "sess-9",
      filename: "seg-0.m3u8",
    });
    expect(result.streamDeleted).toBe(true);
  });

  it("selects the call type off the Meeting it is already reading", async () => {
    // No extra query, and no second source of truth: the row that carries the
    // vendor pointers is read once and answers for the type as well.
    recordingFindUnique.mockResolvedValue(row("livestream"));
    mockListRecordings.mockResolvedValue(listed());

    await RecordingTransferService.deleteRecording("rec-1");

    expect(recordingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          meeting: { select: { id: true, callType: true } },
        }),
      }),
    );
  });

  it("keeps a 1:1 on `default:`, which is what it always was", async () => {
    recordingFindUnique.mockResolvedValue({
      ...row("default"),
      streamCallId: "occurrence-11",
    });
    mockListRecordings.mockResolvedValue({
      recordings: [{ filename: "seg-0.m3u8", session_id: "sess-1", url: "u" }],
    });

    await RecordingTransferService.deleteRecording("rec-1");

    expect(addressed()).toEqual(["default", "occurrence-11"]);
  });

  it("falls back to `default` for a recording whose Meeting is gone", async () => {
    // Cascade-deleted, or an org teardown. The conservative type is the right
    // answer for the same reason it is everywhere else: the worst a wrong guess
    // does here is leave the vendor copy to Stream's own expiry clock.
    recordingFindUnique.mockResolvedValue({
      ...row("livestream"),
      meeting: null,
    });

    await RecordingTransferService.deleteRecording("rec-1");

    expect(addressed()).toEqual(["default", "occurrence-ls-9"]);
  });
});
