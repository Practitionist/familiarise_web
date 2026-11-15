/**
 * @jest-environment node
 */

/**
 * #1134 P1-2 — the durability half of the Stream webhook path.
 *
 * The design is correct and stays: Stream retries inside a FIFTEEN SECOND total
 * budget at six seconds per request, which a cold Netlify instance cannot fit a
 * full handler into, so the route acknowledges and processes in `after()`.
 *
 * What was wrong was the durability ARGUMENT, which was circular. It said
 * durability came from the `WebhookEvent` row and the sweeper, while the row
 * itself was written inside `after()` — on the far side of the acknowledgement.
 * Three paths therefore lost a first delivery silently, and in every one of them
 * Stream had already been told 200 and would never redeliver:
 *
 *   1. the instance freezing between the ack and `after()` running
 *   2. the DB-health probe inside the handler returning unhealthy and returning
 *      early, before anything was written
 *   3. `logWebhookEvent` itself failing
 *
 * The sweeper can only re-drive rows that exist, so none of the three was
 * recoverable. These tests pin the ordering that makes the guarantee real.
 */

const mockLogWebhookEvent = jest.fn();
const mockMarkProcessed = jest.fn();
const mockIsDbHealthy = jest.fn();
const mockHandleRecordingReady = jest.fn();
const mockCreate = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      create: (...a: unknown[]) => mockCreate(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));

/** Ordered trace, so we can assert sequence rather than mere occurrence. */
let sequence: string[] = [];

jest.mock("../../lib/webhooks/event-log", () => ({
  // The real constant, not a copy. This suite asserts that what dispatch stamps
  // is something the sweeper's selector will actually skip, so a hand-written
  // duplicate here would assert the two agree while guaranteeing they cannot.
  TERMINAL_ERROR_PREFIXES: jest.requireActual("../../lib/webhooks/event-log")
    .TERMINAL_ERROR_PREFIXES,
  toInputJson: jest.requireActual("../../lib/webhooks/event-log").toInputJson,
  logWebhookEvent: (...a: unknown[]) => {
    sequence.push("persist");
    return mockLogWebhookEvent(...a);
  },
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => mockIsDbHealthy(),
  // #1280 — a schema mismatch is stamped with this prefix so the sweeper never
  // re-drives it. Not mocking it made `permanentFailure` undefined, the call
  // threw a TypeError into the outer catch, and the completion mark never ran —
  // which read exactly like the early-return regression the case below pins.
  permanentFailure: (reason: string) => `permanent: ${reason}`,
}));

// Relative paths, not the `@/` alias — the alias resolves to a different module
// instance here, so the mock silently does not bind and the failure looks
// identical to a bad fixture.
jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: jest.fn(),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: (...a: unknown[]) => mockHandleRecordingReady(...a),
  handleRecordingFailed: jest.fn(),
}));

jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: jest.fn(),
  handleCallEnded: jest.fn(),
  handleSessionParticipantJoined: jest.fn(),
  handleSessionParticipantLeft: jest.fn(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  HANDLED_EVENT_TYPES,
  isHandledEventType,
  recordStreamEventReceipt,
  processStreamEvent,
  streamRecordingFailedSchema,
} from "../../lib/stream/webhook-dispatch";
import {
  IGNORED_EVENT_TYPES,
  isIgnoredEventType,
} from "../../lib/stream/webhook-events";
import { TERMINAL_ERROR_PREFIXES } from "../../lib/webhooks/event-log";

const CLAIM = { claimedAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  sequence = [];
  // The claim the log hands back is threaded to the completion write (#1741).
  mockLogWebhookEvent.mockResolvedValue({
    isNew: true,
    eventRecordId: "r1",
    claim: { claimedAt: null },
  });
  mockMarkProcessed.mockResolvedValue(undefined);
  mockIsDbHealthy.mockResolvedValue(true);
  mockHandleRecordingReady.mockResolvedValue(undefined);
});

describe("recordStreamEventReceipt — the durable half", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ id: "r1" });
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("writes the delivery down with exactly one create and nothing else", async () => {
    const res = await recordStreamEventReceipt(
      "stream_abc",
      "call.recording_stopped",
      {
        type: "call.recording_stopped",
        call_cid: "default:x",
        created_at: "t",
      },
      "sig",
    );

    expect(res).toEqual({ isNew: true, claim: { claimedAt: null } });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      provider: "stream",
      eventId: "stream_abc",
      eventType: "call.recording_stopped",
      signature: "sig",
      processed: false,
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    // No health probe on the request path — that is the whole point of the
    // split. A probe is another round-trip inside a six-second budget.
    expect(mockIsDbHealthy).not.toHaveBeenCalled();
  });

  it.each([
    ["classic", { code: "P2002", meta: { target: ["eventId"] } }],
    [
      "Prisma 7 adapter",
      {
        code: "P2002",
        meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
      },
    ],
  ])("treats a %s unique violation as a duplicate", async (_shape, error) => {
    mockCreate.mockRejectedValue(error);

    const res = await recordStreamEventReceipt(
      "stream_abc",
      "call.ended",
      {},
      undefined,
    );

    expect(res).toEqual({ isNew: false, claim: { claimedAt: null } });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("re-claims a duplicate whose in-progress lease went stale", async () => {
    mockCreate.mockRejectedValue({ code: "P2002" });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await recordStreamEventReceipt(
      "stream_abc",
      "call.ended",
      {},
      undefined,
    );

    expect(res.isNew).toBe(true);
    expect(res.claim.claimedAt).toBeInstanceOf(Date);
  });

  it("propagates a write failure so the caller can refuse the ack", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));

    // Nothing was recorded, so Stream's redelivery is the only remaining
    // chance. Swallowing this is what made the loss silent.
    await expect(
      recordStreamEventReceipt("stream_abc", "call.ended", {}, undefined),
    ).rejects.toThrow("db down");
  });
});

describe("processStreamEvent — dispatches under the receipt's claim", () => {
  it("never re-claims the row the route just wrote and fences completion on its claim", async () => {
    const claim = { claimedAt: new Date("2026-09-01T00:00:00Z") };
    await processStreamEvent({}, "call.ended", "stream_abc", {}, claim);

    // A bare `{}` fails the handler schema, so the completion mark proves dispatch ran.
    expect(sequence).not.toContain("persist");
    expect(mockMarkProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkProcessed.mock.calls[0][0]).toBe("stream_abc");
    expect(mockMarkProcessed.mock.calls[0][2]).toBe(claim);
  });

  it("never throws — the response is already sent, so there is nobody to signal", async () => {
    mockMarkProcessed.mockRejectedValue(new Error("boom"));

    await expect(
      processStreamEvent({}, "call.ended", "stream_abc", {}, CLAIM),
    ).resolves.toBeUndefined();
  });

  it("stops on an unhandled type without pretending to process it", async () => {
    await processStreamEvent({}, "call.not_a_real_event", "id", {}, CLAIM);

    expect(mockMarkProcessed).toHaveBeenCalledWith("id", undefined, CLAIM);
  });
});

describe("a payload that cannot match its schema is terminal, not retryable", () => {
  /**
   * #1280 — the eight `.parse()` sites threw a ZodError into the handler catch,
   * which stamped it as an ordinary failure. The sweeper re-drives any errored
   * row every ten minutes for a 168-hour give-up window, so a payload that can
   * never be valid churned through roughly a thousand attempts and then aged out
   * on its own — burning the sweeper's budget and hiding a real contract break
   * behind noise nobody had to act on.
   */
  it("stamps the terminal prefix so the sweeper skips it for good", async () => {
    // `{}` satisfies neither `call_cid` nor `call_recording`.
    await processStreamEvent(
      {},
      "call.recording_ready",
      "stream_bad",
      {},
      CLAIM,
    );

    expect(mockMarkProcessed).toHaveBeenCalledTimes(1);
    const [id, error] = mockMarkProcessed.mock.calls[0] as [string, string];
    expect(id).toBe("stream_bad");
    // The prefix is what the sweeper's selector matches on. Losing it would
    // silently restore the churn.
    expect(error).toMatch(/^permanent: /);
    expect(TERMINAL_ERROR_PREFIXES.some((p) => error.startsWith(p))).toBe(true);
  });

  it("names the offending fields, so the alert is actionable", async () => {
    await processStreamEvent(
      {},
      "call.recording_ready",
      "stream_bad",
      {},
      CLAIM,
    );

    const [, error] = mockMarkProcessed.mock.calls[0] as [string, string];
    // A contract break is worth one alert that says WHICH field moved, rather
    // than a thousand retries that say nothing.
    expect(error).toContain("call.recording_ready");
    expect(error).toContain("call_cid");
  });

  it("does not reach the handler at all", async () => {
    await processStreamEvent(
      {},
      "call.recording_ready",
      "stream_bad",
      {},
      CLAIM,
    );

    expect(mockHandleRecordingReady).not.toHaveBeenCalled();
  });

  it("still runs the handler when the payload IS valid", async () => {
    // The counterweight: the guard above must not be rejecting good traffic.
    await processStreamEvent(
      {
        type: "call.recording_ready",
        call_cid: "default:slot-1",
        created_at: "2026-09-01T00:30:05Z",
        call_recording: {
          filename: "rec.mp4",
          url: "https://example.invalid/rec.mp4",
          start_time: "2026-09-01T00:00:00Z",
          end_time: "2026-09-01T00:30:00Z",
        },
      },
      "call.recording_ready",
      "stream_good",
      { call_cid: "default:slot-1" },
      CLAIM,
    );

    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
    expect(mockMarkProcessed).toHaveBeenCalledWith(
      "stream_good",
      undefined,
      CLAIM,
    );
  });
});

describe("the handled-event list and the switch cannot drift apart", () => {
  it("isHandledEventType accepts exactly the published list", () => {
    for (const t of HANDLED_EVENT_TYPES) {
      expect(isHandledEventType(t)).toBe(true);
    }
    expect(isHandledEventType("call.invented")).toBe(false);
  });

  it("covers the four categories the subscription depends on", () => {
    // Verified against the live app's hook config: it was subscribed to six of
    // these, which is why attendance shipped dead. ensure-webhook-subscription.ts
    // widens it; this pins what it must widen to. The chat moderation events
    // were removed in #1270 — see the note in lib/stream/webhook-events.ts.
    for (const t of [
      "call.recording_ready",
      "call.session_ended",
      "call.session_participant_joined",
      "call.ended",
    ]) {
      expect(HANDLED_EVENT_TYPES as readonly string[]).toContain(t);
    }
  });
});

describe("Stream payload shapes the handlers rely on", () => {
  it("parses the real call.recording_failed payload (no error detail)", () => {
    const parsed = streamRecordingFailedSchema.parse({
      type: "call.recording_failed",
      call_cid: "default:abc",
      egress_id: "call_recorder:unique",
      created_at: "2026-10-09T22:54:24.056855645Z",
      recording_type: "composite",
    });
    expect(parsed).toMatchObject({
      egress_id: "call_recorder:unique",
      recording_type: "composite",
    });
  });

  it("acknowledges call.session_started as ignored, never as a handled event", async () => {
    expect(isIgnoredEventType("call.session_started")).toBe(true);
    for (const t of IGNORED_EVENT_TYPES) {
      expect(isHandledEventType(t)).toBe(false);
    }

    await processStreamEvent(
      {},
      "call.session_started",
      "stream_ss",
      { call_cid: "default:abc" },
      CLAIM,
    );
    expect(mockHandleRecordingReady).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalledWith(
      "stream_ss",
      undefined,
      expect.anything(),
    );
  });
});
