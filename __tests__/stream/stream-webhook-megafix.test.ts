/**
 * @jest-environment node
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
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
    appointmentOccurrence: {
      update: jest.fn(),
    },
    newsletterSubscriber: {
      updateMany: jest.fn(),
    },
  };

  return {
    __esModule: true,
    default: {
      ...txMock,
      recording: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        updateManyAndReturn: jest.fn(),
      },
      webhookEvent: { create: jest.fn() },
      $transaction: jest.fn((fn: (tx: typeof txMock) => unknown) => fn(txMock)),
      __tx: txMock,
    },
  };
});

jest.mock("../../lib/webhooks/event-log", () => {
  const actual = jest.requireActual("../../lib/webhooks/event-log");
  return {
    ...actual,
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

import prisma from "../../lib/prisma";
import {
  isDbHealthy,
  markWebhookEventProcessed,
} from "../../lib/webhooks/event-log";
import { notifyRecordingFailed } from "../../lib/novu/service";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";
import { getStreamChatClient } from "../../lib/stream-client";
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
import { evaluateHookDrift } from "../../lib/stream/control-plane-contract";
import {
  DRIFT_EXIT_CODE,
  ensureWebhookSubscription,
} from "../../scripts/stream/ensure-webhook-subscription";
import { classifySessionOutcome } from "../../lib/booking/session-outcome";
import { handleCallEnded } from "../../lib/stream/session-handlers";
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

function postSignedJsonWebhook(
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const buf = Buffer.from(JSON.stringify(payload));
  return POST(
    makeWebhookRequest(buf, {
      "x-signature": signRaw(buf),
      "x-api-key": API_KEY,
      ...extraHeaders,
    }),
  );
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
      expect(verifyStreamApiKeyHeader(null, API_KEY)).toBe(false);
      expect(verifyStreamApiKeyHeader("", API_KEY)).toBe(false);
      expect(verifyStreamApiKeyHeader(null, "")).toBe(true);
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

    it("rejects missing or mismatched X-Api-Key with 401 before touching body stream", async () => {
      for (const headers of [
        { "x-signature": "a".repeat(64) } as Record<string, string>,
        { "x-signature": "a".repeat(64), "x-api-key": "different-app-key" },
      ]) {
        const req = makeWebhookRequest(Buffer.from("{}"), headers);
        const getReaderSpy = jest.spyOn(req.body!, "getReader");

        const res = await POST(req);
        expect(res.status).toBe(401);
        expect(getReaderSpy).not.toHaveBeenCalled();
      }
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
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("2. Zero-DB out-of-window drop & X-Webhook-Id eventId", () => {
    it("enforces exact 10m past and 2m future replay window boundaries", async () => {
      const staleRes = await postSignedJsonWebhook({
        type: "call.recording_stopped",
        call_cid: "default:call-stale",
        created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      expect(staleRes.status).toBe(200);
      await expect(staleRes.json()).resolves.toMatchObject({
        status: "ok",
        ignored: true,
        accepted: false,
      });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();

      const futureRes = await postSignedJsonWebhook({
        type: "call.recording_stopped",
        call_cid: "default:call-future",
        created_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      });
      expect(futureRes.status).toBe(200);
      await expect(futureRes.json()).resolves.toMatchObject({
        status: "ok",
        ignored: true,
        accepted: false,
      });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();

      (prisma.webhookEvent.create as jest.Mock).mockResolvedValue({});
      (markWebhookEventProcessed as jest.Mock).mockResolvedValue(undefined);
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue(null);

      for (const offsetMs of [-9 * 60_000, 90_000]) {
        const validRes = await postSignedJsonWebhook({
          type: "call.recording_stopped",
          call_cid: "default:call-in-window",
          created_at: new Date(Date.now() + offsetMs).toISOString(),
        });
        expect(validRes.status).toBe(200);
        await expect(validRes.json()).resolves.toMatchObject({
          status: "ok",
          accepted: true,
        });
      }
      expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    });

    it("uses stream_${X-Webhook-Id} and skips redundant isDbHealthy() inside dispatch", async () => {
      (prisma.webhookEvent.create as jest.Mock).mockResolvedValue({});
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
      expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: "stream",
          eventId: "stream_wh-uuid-12345",
          eventType: "call.recording_stopped",
          signature: expect.any(String),
        }),
      });
      expect(isDbHealthy).not.toHaveBeenCalled();
      expect(markWebhookEventProcessed).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Exact handled-event subscription & wildcard drift pruning", () => {
    it("ignores legacy webhook_events wildcard when webhook_url is empty, and clears active legacy webhook_url on apply", async () => {
      expect(DESIRED_EVENT_TYPES).toHaveLength(9);
      expect(DESIRED_EVENT_TYPES).toContain("call.stats_report_ready");
      expect(DESIRED_EVENT_TYPES).toEqual(HANDLED_EVENT_TYPES);
      expect(DESIRED_EVENT_TYPES).not.toContain("call.session_started");

      const baseHook: Parameters<typeof evaluateHookDrift>[0] = {
        id: "hook_1",
        hook_type: "webhook",
        enabled: true,
        webhook_url: "https://familiarise.com/api/stream/webhooks",
        event_types: [...DESIRED_EVENT_TYPES],
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
      const getAppSettings = jest
        .fn()
        // 1. Dormant legacy wildcard with empty webhook_url -> no drift
        .mockResolvedValueOnce({
          app: {
            webhook_url: "",
            webhook_events: ["*"],
            event_hooks: [baseHook],
          },
        })
        // 2 & 3. Active legacy webhook_url + extra hook event -> drift, then cleared on apply
        .mockResolvedValue({
          app: {
            webhook_url: "https://familiarise.com/api/stream/legacy-hook",
            webhook_events: ["*"],
            event_hooks: [
              {
                ...baseHook,
                event_types: [...DESIRED_EVENT_TYPES, "call.session_started"],
              },
            ],
          },
        });

      (getStreamChatClient as jest.Mock).mockReturnValue({
        getAppSettings,
        updateAppSettings,
      });

      await expect(ensureWebhookSubscription("check")).resolves.toBe(0);
      await expect(ensureWebhookSubscription("check")).resolves.toBe(
        DRIFT_EXIT_CODE,
      );

      const applyCode = await ensureWebhookSubscription("apply");
      expect(applyCode).toBe(0);
      expect(updateAppSettings).toHaveBeenCalledWith({
        event_hooks: [
          expect.objectContaining({
            id: "hook_1",
            event_types: [...DESIRED_EVENT_TYPES].sort(),
          }),
        ],
        webhook_url: "",
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
        maintenanceWindows: [],
      });
      expect(hostEnded.outcome).toBe("CUT_SHORT");
      expect(hostEnded.hostAttributed).toBe(true);
    });

    it("maps a Stream-side end with no user actor to stream_ended, never the raw reason", async () => {
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

      await handleCallEnded({
        type: "call.ended",
        call_cid: "default:call-1",
        reason: "session_inactivity_timeout",
        created_at: "2026-10-10T10:25:00Z",
      });

      expect(prisma.meeting.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ endedReason: "stream_ended" }),
        }),
      );
    });
  });

  describe("5. Recording rebound fallback, CAS transitions & chunked notifications", () => {
    it("extracts slotId from rebound call IDs and falls back to appointmentOccurrenceId", () => {
      expect(parseSlotIdFromCallId("slot-occ123-r1")).toBe("occ123");
      expect(parseSlotIdFromCallId("slot-occ123")).toBe("occ123");
      expect(parseSlotIdFromCallId("occurrence-occ456-r2")).toBe("occ456");
      expect(parseSlotIdFromCallId("unrelated-call")).toBeNull();
    });

    it("advances recordingStartedAt monotonically on handleRecordingStarted and transitions RECORDING -> PROCESSING on stop", async () => {
      (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
        id: "mtg-rec",
        streamCallId: "call-rec",
        recordingStartedAt: new Date("2026-10-10T10:10:00Z"),
        recordingStartedBy: "host-1",
      });
      (prisma.meeting.update as jest.Mock).mockResolvedValue({});
      (prisma.meeting.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.recording.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      // Out-of-order older started timestamp does not move recordingStartedAt backwards
      await handleRecordingStarted({
        type: "call.recording_started",
        call_cid: "default:call-rec",
        created_at: "2026-10-10T10:05:00Z",
      });
      expect(prisma.meeting.updateMany).toHaveBeenLastCalledWith({
        where: { id: "mtg-rec", streamCallId: "call-rec", endedAt: null },
        data: { isRecording: true },
      });

      // Newer started timestamp advances recordingStartedAt
      await handleRecordingStarted({
        type: "call.recording_started",
        call_cid: "default:call-rec",
        created_at: "2026-10-10T10:15:00Z",
      });
      expect(prisma.meeting.updateMany).toHaveBeenLastCalledWith({
        where: { id: "mtg-rec", streamCallId: "call-rec", endedAt: null },
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
      // By filename, then the erased-row lookup, then the FAILED placeholder.
      (prisma.recording.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
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
