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

/** Ordered trace, so we can assert sequence rather than mere occurrence. */
let sequence: string[] = [];

jest.mock("../../lib/webhooks/event-log", () => ({
  logWebhookEvent: (...a: unknown[]) => {
    sequence.push("persist");
    return mockLogWebhookEvent(...a);
  },
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => mockIsDbHealthy(),
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
} from "../../lib/stream/webhook-dispatch";

beforeEach(() => {
  jest.clearAllMocks();
  sequence = [];
  mockLogWebhookEvent.mockResolvedValue({ isNew: true, eventRecordId: "r1" });
  mockMarkProcessed.mockResolvedValue(undefined);
  mockIsDbHealthy.mockResolvedValue(true);
});

describe("recordStreamEventReceipt — the durable half", () => {
  it("writes the delivery down and nothing else", async () => {
    await recordStreamEventReceipt("stream_abc", "call.ended", { a: 1 }, "sig");

    expect(mockLogWebhookEvent).toHaveBeenCalledWith(
      "stream",
      "stream_abc",
      "call.ended",
      { a: 1 },
      "sig",
    );
    // No health probe on the request path — that is the whole point of the
    // split. A probe is another round-trip inside a six-second budget.
    expect(mockIsDbHealthy).not.toHaveBeenCalled();
  });

  it("propagates a write failure so the caller can refuse the ack", async () => {
    mockLogWebhookEvent.mockRejectedValue(new Error("db down"));

    // Nothing was recorded, so Stream's redelivery is the only remaining
    // chance. Swallowing this is what made the loss silent.
    await expect(
      recordStreamEventReceipt("stream_abc", "call.ended", {}, undefined),
    ).rejects.toThrow("db down");
  });
});

describe("processStreamEvent — safe to defer, now that the receipt exists", () => {
  it("defers to the sweeper when the DB is unhealthy", async () => {
    mockIsDbHealthy.mockResolvedValue(false);

    await processStreamEvent({}, "call.ended", "stream_abc", undefined, {});

    // Returning here is only safe BECAUSE the route already persisted the
    // receipt. Before that, this branch wrote nothing and deferred to a sweeper
    // with nothing to find.
    expect(sequence).not.toContain("persist");
  });

  it("dispatches inline when the caller already holds the claim", async () => {
    // The regression this pins: the route persists the receipt, then dispatches
    // in after(). Re-claiming there means logWebhookEvent sees the row it just
    // created — IN-PROGRESS, aged milliseconds — and correctly refuses it as
    // another worker's in-flight work. `isNew` came back false and dispatch
    // returned having handled nothing, so every event waited for the sweeper.
    mockLogWebhookEvent.mockResolvedValue({ isNew: false });

    await processStreamEvent({}, "call.ended", "stream_abc", undefined, {}, {
      claimAlreadyHeld: true,
    });

    // It must NOT have consulted the claim, and must have reached dispatch
    // rather than bailing out. The payload here is a bare `{}`, so the handler's
    // Zod schema rejects it and the completion carries that error — which is
    // itself the proof: reaching validation means the early return did not fire.
    expect(sequence).not.toContain("persist");
    expect(mockMarkProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkProcessed.mock.calls[0][0]).toBe("stream_abc");
  });

  it("still yields to a real competitor when it does NOT hold the claim", async () => {
    // The sweeper path. Here `isNew: false` genuinely means another worker owns
    // it, and returning is correct — this is the case the earlier stub hid by
    // always answering true.
    mockLogWebhookEvent.mockResolvedValue({ isNew: false });

    await processStreamEvent({}, "call.ended", "stream_abc", undefined, {});

    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it("never throws — the response is already sent, so there is nobody to signal", async () => {
    mockLogWebhookEvent.mockRejectedValue(new Error("boom"));

    await expect(
      processStreamEvent({}, "call.ended", "stream_abc", undefined, {}),
    ).resolves.toBeUndefined();
  });

  it("stops on an unhandled type without pretending to process it", async () => {
    await processStreamEvent({}, "call.not_a_real_event", "id", undefined, {});

    expect(mockMarkProcessed).toHaveBeenCalledWith("id", undefined);
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
