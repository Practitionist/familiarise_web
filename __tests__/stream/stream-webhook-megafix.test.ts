/**
 * @jest-environment node
 */
import crypto from "crypto";
import zlib from "zlib";
import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => {
  const txMock = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    meeting: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    meetingPresence: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    meetingAttendance: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    appointmentOccurrence: {
      update: jest.fn(),
    },
    waitlist: {
      updateMany: jest.fn(),
    },
  };

  return {
    __esModule: true,
    default: {
      ...txMock,
      recording: {
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        updateManyAndReturn: jest.fn(),
      },
      $transaction: jest.fn((fn: (tx: typeof txMock) => unknown) => fn(txMock)),
      __tx: txMock,
    },
  };
});

jest.mock("../../lib/webhooks/event-log", () => {
  const actual = jest.requireActual("../../lib/webhooks/event-log");
  return {
    ...actual,
    logWebhookEvent: jest.fn(),
    markWebhookEventProcessed: jest.fn(),
    isDbHealthy: jest.fn().mockResolvedValue(true),
  };
});

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../lib/novu/service", () => ({
  notifyRecordingAvailable: jest.fn().mockResolvedValue([]),
  notifyRecordingFailed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/novu", () => ({
  attemptTrigger: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/stream/recording-decline", () => ({
  wasDeclinedDuringRecording: jest.fn().mockResolvedValue(false),
  discardDeclinedRecording: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/stream/recording-utils", () => ({
  generateRecordingTitle: jest.fn(() => "Session Recording"),
  getEventAttendeeIds: jest.fn().mockResolvedValue([]),
  streamCopyExpiresAt: jest.fn(
    (d: Date) => new Date(d.getTime() + 14 * 86_400_000),
  ),
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
  getStreamVideoClient: jest.fn(),
  isStreamConfigured: jest.fn(() => true),
}));

jest.mock("../../lib/stream/call-presence", () => ({
  getCallParticipantSessionsFromStream: jest.fn().mockResolvedValue([]),
}));

import prisma from "../../lib/prisma";
import {
  isDbHealthy,
  logWebhookEvent,
  markWebhookEventProcessed,
} from "../../lib/webhooks/event-log";
import { notifyRecordingFailed } from "../../lib/novu/service";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";
import { getStreamChatClient } from "../../lib/stream-client";
import { getCallParticipantSessionsFromStream } from "../../lib/stream/call-presence";
import { POST } from "../../app/api/stream/webhooks/route";
import {
  MAX_WEBHOOK_COMPRESSED_BYTES,
  MAX_WEBHOOK_DECOMPRESSED_BYTES,
  isValidStreamSignatureFormat,
  verifyStreamApiKeyHeader,
} from "../../lib/stream/webhook-signature";
import {
  DESIRED_EVENT_TYPES,
  HANDLED_EVENT_TYPES,
} from "../../lib/stream/webhook-events";
import {
  DRIFT_EXIT_CODE,
  ensureWebhookSubscription,
  evaluateHookDrift,
} from "../../scripts/stream/ensure-webhook-subscription";
import { classifySessionOutcome } from "../../lib/booking/session-outcome";
import {
  handleCallEnded,
  handleSessionEnded,
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
} from "../../lib/stream/session-handlers";
import {
  handleRecordingFailed,
  handleRecordingReady,
  handleRecordingStarted,
  handleRecordingStopped,
  parseSlotIdFromCallId,
} from "../../lib/stream/recording-handlers";

const SECRET = "test-stream-webhook-secret";
const API_KEY = "test-stream-api-key";

function signRaw(buf: Buffer, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

function makeWebhookRequest(
  body: Buffer | ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): NextRequest {
  const normalizedBody: BodyInit = Buffer.isBuffer(body)
    ? new Blob([Uint8Array.from(body)])
    : body;
  return new NextRequest("https://familiarise.com/api/stream/webhooks", {
    method: "POST",
    headers,
    body: normalizedBody,
  });
}

describe("Stream Webhook Megafix Regression Suite", () => {
  const origSecret = process.env.STREAM_WEBHOOK_SECRET;
  const origApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STREAM_WEBHOOK_SECRET = SECRET;
    process.env.NEXT_PUBLIC_STREAM_API_KEY = API_KEY;
    delete process.env.STREAM_WEBHOOK_SECRET_PREVIOUS;
  });

  afterAll(() => {
    if (origSecret === undefined) delete process.env.STREAM_WEBHOOK_SECRET;
    else process.env.STREAM_WEBHOOK_SECRET = origSecret;

    if (origApiKey === undefined) delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
    else process.env.NEXT_PUBLIC_STREAM_API_KEY = origApiKey;
  });

  describe("1. Pre-body header validation & gzip bomb / payload cap", () => {
    it("validates 64-char hex X-Signature and constant-time X-Api-Key helpers", () => {
      expect(isValidStreamSignatureFormat("a".repeat(64))).toBe(true);
      expect(isValidStreamSignatureFormat("not-hex".padEnd(64, "z"))).toBe(
        false,
      );
      expect(isValidStreamSignatureFormat("short")).toBe(false);
      expect(isValidStreamSignatureFormat(null)).toBe(false);

      expect(verifyStreamApiKeyHeader(API_KEY, API_KEY)).toBe(true);
      expect(verifyStreamApiKeyHeader("wrong-key", API_KEY)).toBe(false);
      expect(verifyStreamApiKeyHeader(null, API_KEY)).toBe(true);
    });

    it("rejects missing or non-hex X-Signature with 401 before touching body stream", async () => {
      const req = makeWebhookRequest(Buffer.from("{}"), {
        "x-signature": "invalid-signature",
        "x-api-key": API_KEY,
      });
      const getReaderSpy = jest.spyOn(req.body!, "getReader");

      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(getReaderSpy).not.toHaveBeenCalled();
    });

    it("rejects mismatched X-Api-Key with 401 before touching body stream", async () => {
      const req = makeWebhookRequest(Buffer.from("{}"), {
        "x-signature": "a".repeat(64),
        "x-api-key": "different-app-key",
      });
      const getReaderSpy = jest.spyOn(req.body!, "getReader");

      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(getReaderSpy).not.toHaveBeenCalled();
    });

    it("rejects Content-Length > 512 KiB with 413 before reading body", async () => {
      const res = await POST(
        makeWebhookRequest(Buffer.from("{}"), {
          "x-signature": "a".repeat(64),
          "x-api-key": API_KEY,
          "content-length": String(MAX_WEBHOOK_COMPRESSED_BYTES + 1),
        }),
      );
      expect(res.status).toBe(413);
    });

    it("rejects streaming chunked body exceeding 512 KiB with 413", async () => {
      const chunk = new Uint8Array(300 * 1024);
      let emitted = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted < 2) {
            emitted += 1;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });

      const res = await POST(
        makeWebhookRequest(stream, {
          "x-signature": "a".repeat(64),
          "x-api-key": API_KEY,
        }),
      );
      expect(res.status).toBe(413);
    });

    it("defends against gzip bombs expanding beyond 2 MiB with 413", async () => {
      const bombUncompressed = Buffer.alloc(
        MAX_WEBHOOK_DECOMPRESSED_BYTES + 64 * 1024,
        "a",
      );
      const compressedBomb = zlib.gzipSync(bombUncompressed);
      expect(compressedBomb.length).toBeLessThan(MAX_WEBHOOK_COMPRESSED_BYTES);

      const res = await POST(
        makeWebhookRequest(compressedBomb, {
          "x-signature": signRaw(bombUncompressed),
          "x-api-key": API_KEY,
          "content-encoding": "gzip",
        }),
      );
      expect(res.status).toBe(413);
      expect(logWebhookEvent).not.toHaveBeenCalled();
    });
  });

  describe("2. Zero-DB out-of-window drop & X-Webhook-Id eventId", () => {
    it("drops out-of-window (>7d) and clock-skewed (>5m future) deliveries with 200 without DB writes", async () => {
      const stalePayload = Buffer.from(
        JSON.stringify({
          type: "call.recording_stopped",
          call_cid: "default:call-stale",
          created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        }),
      );
      const staleRes = await POST(
        makeWebhookRequest(stalePayload, {
          "x-signature": signRaw(stalePayload),
          "x-api-key": API_KEY,
        }),
      );
      expect(staleRes.status).toBe(200);
      await expect(staleRes.json()).resolves.toMatchObject({
        status: "ok",
        ignored: true,
        accepted: false,
      });
      expect(logWebhookEvent).not.toHaveBeenCalled();

      const futurePayload = Buffer.from(
        JSON.stringify({
          type: "call.recording_stopped",
          call_cid: "default:call-future",
          created_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      );
      const futureRes = await POST(
        makeWebhookRequest(futurePayload, {
          "x-signature": signRaw(futurePayload),
          "x-api-key": API_KEY,
        }),
      );
      expect(futureRes.status).toBe(200);
      await expect(futureRes.json()).resolves.toMatchObject({
        status: "ok",
        ignored: true,
        accepted: false,
      });
      expect(logWebhookEvent).not.toHaveBeenCalled();
    });

    it("uses stream_${X-Webhook-Id} and skips redundant isDbHealthy() inside dispatch", async () => {
      const claimedAt = new Date();
      (logWebhookEvent as jest.Mock).mockResolvedValue({
        isNew: true,
        claim: { claimedAt },
      });
      (markWebhookEventProcessed as jest.Mock).mockResolvedValue(undefined);
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue(null);

      const uncompressed = Buffer.from(
        JSON.stringify({
          type: "call.recording_stopped",
          call_cid: "default:call-id-check",
          created_at: new Date().toISOString(),
        }),
      );
      const gzPayload = zlib.gzipSync(uncompressed);

      const res = await POST(
        makeWebhookRequest(gzPayload, {
          "x-signature": signRaw(uncompressed),
          "x-api-key": API_KEY,
          "x-webhook-id": "wh-uuid-12345",
          "content-encoding": "gzip",
        }),
      );
      expect(res.status).toBe(200);
      expect(logWebhookEvent).toHaveBeenCalledWith(
        "stream",
        "stream_wh-uuid-12345",
        "call.recording_stopped",
        expect.any(Object),
        expect.any(String),
      );
      expect(isDbHealthy).not.toHaveBeenCalled();
      expect(markWebhookEventProcessed).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Exact 8-event subscription & wildcard drift pruning", () => {
    it("excludes call.session_started from DESIRED_EVENT_TYPES and detects [] / * / extra drift", async () => {
      expect(DESIRED_EVENT_TYPES).toHaveLength(8);
      expect(DESIRED_EVENT_TYPES).toEqual(HANDLED_EVENT_TYPES);
      expect(DESIRED_EVENT_TYPES).not.toContain("call.session_started");

      const baseHook: Parameters<typeof evaluateHookDrift>[0] = {
        id: "hook_1",
        hook_type: "webhook",
        enabled: true,
        webhook_url: "https://familiarise.com/api/stream/webhooks",
        event_types: [],
      };

      expect(
        evaluateHookDrift({ ...baseHook, event_types: [] }, DESIRED_EVENT_TYPES)
          .receivesAll,
      ).toBe(true);
      expect(
        evaluateHookDrift(
          { ...baseHook, event_types: ["*"] },
          DESIRED_EVENT_TYPES,
        ).receivesAll,
      ).toBe(true);
      expect(
        evaluateHookDrift(
          {
            ...baseHook,
            event_types: [...DESIRED_EVENT_TYPES, "call.session_started"],
          },
          DESIRED_EVENT_TYPES,
        ).extra,
      ).toEqual(["call.session_started"]);

      const updateAppSettings = jest.fn().mockResolvedValue({});
      (getStreamChatClient as jest.Mock).mockReturnValue({
        getAppSettings: jest.fn().mockResolvedValue({
          app: {
            webhook_events: ["*"],
            event_hooks: [
              {
                ...baseHook,
                event_types: [...DESIRED_EVENT_TYPES, "call.session_started"],
              },
            ],
          },
        }),
        updateAppSettings,
      });

      const checkCode = await ensureWebhookSubscription("check");
      expect(checkCode).toBe(DRIFT_EXIT_CODE);

      const applyCode = await ensureWebhookSubscription("apply");
      expect(applyCode).toBe(0);
      expect(updateAppSettings).toHaveBeenCalledWith({
        event_hooks: [
          expect.objectContaining({
            id: "hook_1",
            event_types: [...DESIRED_EVENT_TYPES].sort(),
          }),
        ],
        webhook_events: [],
      });
    });
  });

  describe("4. Host-only CUT_SHORT attribution & deliberate call.ended semantics", () => {
    const windowStart = new Date("2026-10-10T10:00:00Z");
    const windowEnd = new Date("2026-10-10T11:00:00Z");

    it("does not penalize host with CUT_SHORT when consultee clicked End early or call timed out", () => {
      const baseIntervals = [
        {
          userId: "host-1",
          joinedAt: new Date("2026-10-10T10:00:00Z"),
          leftAt: new Date("2026-10-10T10:30:00Z"),
        },
        {
          userId: "learner-1",
          joinedAt: new Date("2026-10-10T10:00:00Z"),
          leftAt: new Date("2026-10-10T10:30:00Z"),
        },
      ];

      // Learner clicked end at 30m (< 80% of 60m) -> NOT CUT_SHORT (hostAttributed: false)
      const learnerEnded = classifySessionOutcome({
        startsAt: windowStart,
        endsAt: windowEnd,
        hostUserIds: ["host-1"],
        intervals: baseIntervals,
        meeting: {
          endedAt: new Date("2026-10-10T10:30:00Z"),
          endedReason: "call_ended",
          endedByUserId: "learner-1",
        },
        report: { unique: 2 },
        maintenanceWindows: [],
      });
      expect(learnerEnded.outcome).not.toBe("CUT_SHORT");
      expect(learnerEnded.hostAttributed).toBe(false);

      // System inactivity timeout -> NOT CUT_SHORT (hostAttributed: false)
      const timeoutEnded = classifySessionOutcome({
        startsAt: windowStart,
        endsAt: windowEnd,
        hostUserIds: ["host-1"],
        intervals: baseIntervals,
        meeting: {
          endedAt: new Date("2026-10-10T10:30:00Z"),
          endedReason: "session_timeout",
          endedByUserId: null,
        },
        report: { unique: 2 },
        maintenanceWindows: [],
      });
      expect(timeoutEnded.outcome).not.toBe("CUT_SHORT");
      expect(timeoutEnded.hostAttributed).toBe(false);

      // Host deliberately ended call at 30m -> CUT_SHORT (hostAttributed: true)
      const hostEnded = classifySessionOutcome({
        startsAt: windowStart,
        endsAt: windowEnd,
        hostUserIds: ["host-1"],
        intervals: baseIntervals,
        meeting: {
          endedAt: new Date("2026-10-10T10:30:00Z"),
          endedReason: "call_ended",
          endedByUserId: "host-1",
        },
        report: { unique: 2 },
        maintenanceWindows: [],
      });
      expect(hostEnded.outcome).toBe("CUT_SHORT");
      expect(hostEnded.hostAttributed).toBe(true);
    });

    it("preserves non-deliberate reason on handleCallEnded when no user actor clicked End", async () => {
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-1",
        endedAt: null,
        occurrence: {
          id: "occ-1",
          startsAt: new Date("2026-10-10T10:00:00Z"),
          appointment: { webinar: null, class: null },
        },
      });
      (prisma.meeting.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.meetingPresence.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      await handleCallEnded({
        type: "call.ended",
        call_cid: "default:call-1",
        reason: "session_inactivity_timeout",
        created_at: "2026-10-10T10:25:00Z",
      });

      expect(prisma.meeting.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endedReason: "session_inactivity_timeout",
          }),
        }),
      );
    });
  });

  describe("5. Strict lock ordering & order-independent participant tracking", () => {
    it("acquires Meeting -> MeetingPresence -> MeetingAttendance lock order and clamps left-before-joined", async () => {
      const callOrder: string[] = [];
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-order",
        endedAt: null,
        endedReason: null,
        appointmentOccurrenceId: "occ-1",
      });
      (prisma.meetingPresence.createMany as jest.Mock).mockImplementation(
        async () => {
          callOrder.push("create_presence");
          // Simulate left webhook having arrived BEFORE joined webhook for same session
          return { count: 0 };
        },
      );
      (prisma.meetingPresence.updateMany as jest.Mock).mockImplementation(
        async () => {
          callOrder.push("clamp_presence_joinedAt");
          return { count: 1 };
        },
      );
      (prisma.meetingAttendance.upsert as jest.Mock).mockImplementation(
        async () => {
          callOrder.push("upsert_attendance");
          return {};
        },
      );
      (prisma.meetingAttendance.updateMany as jest.Mock).mockImplementation(
        async () => {
          callOrder.push("clamp_attendance_firstJoinedAt");
          return { count: 1 };
        },
      );

      await handleSessionParticipantJoined({
        type: "call.session_participant_joined",
        call_cid: "default:call-order",
        session_id: "sess-parent",
        participant: {
          user: { id: "user-1" },
          user_session_id: "sess-1",
        },
        created_at: "2026-10-10T10:02:00Z",
      });

      expect(callOrder).toEqual([
        "create_presence",
        "clamp_presence_joinedAt",
        "upsert_attendance",
        "clamp_attendance_firstJoinedAt",
      ]);
      expect(prisma.meetingAttendance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {},
        }),
      );
    });

    it("closes joined-after-ended interval immediately with leftAt = meeting.endedAt without clearing lastLeftAt", async () => {
      const endedAt = new Date("2026-10-10T10:30:00Z");
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-ended",
        endedAt,
        endedReason: "call_ended",
        appointmentOccurrenceId: "occ-2",
      });
      (prisma.meetingPresence.createMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.meetingAttendance.upsert as jest.Mock).mockResolvedValue({});
      (prisma.meetingAttendance.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      await handleSessionParticipantJoined({
        type: "call.session_participant_joined",
        call_cid: "default:call-ended",
        session_id: "sess-parent",
        participant: {
          user: { id: "user-2" },
          user_session_id: "sess-late",
        },
        created_at: "2026-10-10T10:31:00Z",
      });

      expect(prisma.meetingPresence.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ leftAt: endedAt })],
        }),
      );
      expect(prisma.meetingAttendance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { joinCount: { increment: 1 } },
        }),
      );
    });

    it("runs reconcileWebinarAttendance on handleSessionEnded even if call.ended is dropped", async () => {
      const joinedAt = new Date("2026-10-10T10:02:00Z");
      const endedAt = new Date("2026-10-10T11:05:00Z");
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-web",
        streamCallId: "webinar-call",
        appointmentOccurrenceId: "occ-web",
        endedAt: null,
        occurrence: {
          id: "occ-web",
          startsAt: new Date("2026-10-10T10:00:00Z"),
          endsAt: new Date("2026-10-10T11:00:00Z"),
        },
      });
      (prisma.meeting.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.meetingPresence.createMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.meetingPresence.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (getCallParticipantSessionsFromStream as jest.Mock).mockResolvedValueOnce(
        [
          {
            userId: "attendee-1",
            userSessionId: "sess-a1",
            joinedAt,
            leftAt: null,
          },
        ],
      );
      (prisma.meetingAttendance.upsert as jest.Mock).mockResolvedValue({});
      (prisma.meetingAttendance.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      await handleSessionEnded({
        type: "call.session_ended",
        call_cid: "default:webinar-call",
        created_at: endedAt.toISOString(),
      });

      expect(prisma.meetingAttendance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            meetingId_userId: { meetingId: "mtg-web", userId: "attendee-1" },
          },
          create: expect.objectContaining({
            firstJoinedAt: joinedAt,
            lastLeftAt: endedAt,
            joinCount: 1,
          }),
        }),
      );
    });

    it("executes handleSessionParticipantLeft in strict MeetingPresence -> MeetingAttendance order inside $transaction", async () => {
      const order: string[] = [];
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-left",
        endedAt: null,
        endedReason: null,
        appointmentOccurrenceId: "occ-left",
      });
      (prisma.meetingPresence.createMany as jest.Mock).mockImplementation(
        async () => {
          order.push("create_presence");
          return { count: 1 };
        },
      );
      (prisma.meetingPresence.updateMany as jest.Mock).mockImplementation(
        async () => {
          order.push("update_presence_leftAt");
          return { count: 1 };
        },
      );
      (prisma.meetingAttendance.upsert as jest.Mock).mockImplementation(
        async () => {
          order.push("upsert_attendance");
          return {};
        },
      );
      (prisma.meetingAttendance.updateMany as jest.Mock).mockImplementation(
        async () => {
          order.push("advance_attendance_lastLeftAt");
          return { count: 1 };
        },
      );

      await handleSessionParticipantLeft({
        type: "call.session_participant_left",
        call_cid: "default:call-left",
        session_id: "sess-parent",
        participant: {
          user: { id: "user-left" },
          user_session_id: "sess-left",
        },
        created_at: "2026-10-10T10:40:00Z",
      });

      expect(order).toEqual([
        "create_presence",
        "update_presence_leftAt",
        "upsert_attendance",
        "advance_attendance_lastLeftAt",
      ]);
    });
  });

  describe("6. Recording rebound fallback, CAS transitions & chunked notifications", () => {
    it("extracts slotId from rebound call IDs and falls back to appointmentOccurrenceId", () => {
      expect(parseSlotIdFromCallId("slot-occ123-r1")).toBe("occ123");
      expect(parseSlotIdFromCallId("slot-occ123")).toBe("occ123");
      expect(parseSlotIdFromCallId("occurrence-occ456-r2")).toBe("occ456");
      expect(parseSlotIdFromCallId("unrelated-call")).toBeNull();
    });

    it("always updates recordingStartedAt on handleRecordingStarted and transitions RECORDING -> PROCESSING on stop", async () => {
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-rec",
        recordingStartedAt: new Date("2026-10-10T10:00:00Z"),
        recordingStartedBy: "host-1",
      });
      (prisma.meeting.update as jest.Mock).mockResolvedValue({});
      (prisma.recording.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      await handleRecordingStarted({
        type: "call.recording_started",
        call_cid: "default:call-rec",
        created_at: "2026-10-10T10:15:00Z",
      });

      expect(prisma.meeting.update).toHaveBeenCalledWith({
        where: { id: "mtg-rec" },
        data: {
          isRecording: true,
          recordingStartedAt: new Date("2026-10-10T10:15:00Z"),
        },
      });

      await handleRecordingStopped({
        type: "call.recording_stopped",
        call_cid: "default:call-rec",
        created_at: "2026-10-10T10:45:00Z",
      });

      expect(prisma.recording.updateMany).toHaveBeenCalledWith({
        where: { meetingId: "mtg-rec", status: "RECORDING" },
        data: { status: "PROCESSING" },
      });
    });

    it("promotes FAILED to READY via CAS on handleRecordingReady and never resurrects EXPIRED rows", async () => {
      // 1. Rebound fallback + FAILED -> READY promotion
      (prisma.meeting.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // direct lookup misses after room rebind
        .mockResolvedValueOnce({
          id: "mtg-rebound",
          isRecording: true,
          occurrence: { appointment: { organizationId: "org-1" } },
        });
      (prisma.recording.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "rec-failed-placeholder",
          status: "FAILED",
          storageType: "STREAM_S3",
        });
      (prisma.recording.updateManyAndReturn as jest.Mock).mockResolvedValue([
        { id: "rec-failed-placeholder", status: "READY" },
      ]);
      (prisma.meeting.update as jest.Mock).mockResolvedValue({});

      await handleRecordingReady({
        type: "call.recording_ready",
        call_cid: "default:slot-occ999-r1",
        call_recording: {
          filename: "rec.mp4",
          url: "https://stream-io.s3.amazonaws.com/rec.mp4",
          start_time: "2026-10-10T10:00:00Z",
          end_time: "2026-10-10T10:30:00Z",
          session_id: "sess-1",
        },
        created_at: "2026-10-10T10:31:00Z",
      });

      expect(prisma.meeting.findUnique).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { appointmentOccurrenceId: "occ999" },
        }),
      );
      expect(prisma.recording.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "rec-failed-placeholder",
            status: { in: ["RECORDING", "PROCESSING", "FAILED"] },
          },
          data: expect.objectContaining({ status: "READY" }),
        }),
      );

      // 2. EXPIRED row is never resurrected to READY
      jest.clearAllMocks();
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-exp",
        isRecording: false,
        occurrence: { appointment: { organizationId: null } },
      });
      (prisma.recording.findFirst as jest.Mock).mockResolvedValue({
        id: "rec-expired",
        status: "EXPIRED",
        storageType: "STREAM_S3",
      });

      await handleRecordingReady({
        type: "call.recording_ready",
        call_cid: "default:call-exp",
        call_recording: {
          filename: "expired.mp4",
          url: "https://stream-io.s3.amazonaws.com/expired.mp4",
          start_time: "2026-10-10T10:00:00Z",
          end_time: "2026-10-10T10:30:00Z",
        },
        created_at: "2026-10-10T10:31:00Z",
      });

      expect(prisma.recording.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it("chunks Novu failure notifications with max concurrency of 5", async () => {
      let active = 0;
      let peakActive = 0;
      (notifyRecordingFailed as jest.Mock).mockImplementation(async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-fail",
        occurrence: {
          appointment: {
            organizationId: "org-1",
            webinar: { id: "web-1" },
            class: null,
          },
        },
      });
      (prisma.meeting.update as jest.Mock).mockResolvedValue({});
      (prisma.recording.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.recording.create as jest.Mock).mockResolvedValue({ id: "rec-f" });
      (getEventAttendeeIds as jest.Mock).mockResolvedValue(
        Array.from({ length: 13 }, (_, idx) => `u-${idx}`),
      );

      await handleRecordingFailed({
        type: "call.recording_failed",
        call_cid: "default:call-fail",
        egress_id: "egress-1",
        recording_type: "composite",
        created_at: "2026-10-10T10:30:00Z",
      });

      expect(notifyRecordingFailed).toHaveBeenCalledTimes(13);
      expect(peakActive).toBeLessThanOrEqual(5);
    });
  });
});
