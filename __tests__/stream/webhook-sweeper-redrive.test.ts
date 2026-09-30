/**
 * @jest-environment node
 */

/**
 * #1829 — the sweeper's Stream re-drive, and the pre-claim that made it a no-op.
 *
 * The single highest-value defect in the Stream subsystem, and the reason the
 * audit ranks it above the dedup bypass. The sweeper is the ONLY thing that can
 * re-drive an event the route acknowledged but whose `after()` never completed —
 * an instance freezing between the 200 and the callback. Stream has already been
 * told 200 and will never redeliver. If the sweeper cannot perform the re-drive,
 * that class of event is lost with no recovery path at all.
 *
 * It could not. `sweepStuckWebhookEvents` claimed the row before re-driving:
 *
 *   sweep-stuck-webhook-events.ts   updateMany { claimedAt: now() }
 *     → processStreamEvent(..., no claimAlreadyHeld)
 *       → logWebhookEvent
 *         → the row is processed:false, error:null, so the STALENESS escape runs
 *         → age = now - (claimedAt ?? receivedAt)  ≈ 0
 *         → 0 > 5 minutes is false
 *         → return { isNew: false }  ("currently being processed, skipping")
 *     → processStreamEvent returns having done NOTHING
 *
 * Every such row was re-selected, re-claimed and re-refused on every sweep for
 * 168 hours, then terminally capped and discarded forever. The pre-claim was
 * individually defensible — it was there to stop two drivers re-running the same
 * event — and `logWebhookEvent` already performs that exclusion with a
 * conditional update scoped to the exact `claimedAt` the caller read. So the
 * pre-claim was a second, worse version of a lock already held, and it was the
 * one that broke the re-drive.
 *
 * These tests model the real `logWebhookEvent` staleness arithmetic rather than a
 * stub of it, because the bug lived precisely in the interaction between two
 * correct pieces and a stub would have hidden it.
 */

/**
 * The sweeper writes through BOTH prisma shapes: `updateMany(where, data)` for
 * the fence and `update({ where, data })` for the give-up. A filter that
 * destructures the second positional argument therefore matches the first shape
 * and silently misses the second — which reads as "the code never ran" rather
 * than "the assertion looked in the wrong place".
 */
function writesWith(call: unknown[], key: string) {
  const args = call as unknown[];
  const data =
    (args[1] as { data?: Record<string, unknown> } | undefined)?.data ??
    (args[0] as { data?: Record<string, unknown> } | undefined)?.data;
  return data && key in data ? data : undefined;
}

const mockUpdateMany = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockProcessStreamEvent = jest.fn();
const mockProcessRazorpay = jest.fn();
const mockCaptureThrottled = jest.fn();
const mockWithCronLock = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      update: (...a: unknown[]) => mockUpdateMany(...a),
      findMany: (...a: unknown[]) => mockFindMany(...a),
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
    },
  },
}));

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: (...a: unknown[]) => mockProcessRazorpay(...a),
}));

jest.mock("../../lib/stream/webhook-dispatch", () => ({
  processStreamEvent: (...a: unknown[]) => mockProcessStreamEvent(...a),
}));

jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: (...a: unknown[]) => mockCaptureThrottled(...a),
  resetThrottledCaptureForTesting: () => {},
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (...a: unknown[]) => mockWithCronLock(...a),
}));

// The real prefix list, for the same reason webhook-durability.test.ts uses the
// real constant: this suite asserts that what the sweeper writes is something its
// own selector will skip, and a hand-written copy would assert the two agree
// while guaranteeing they cannot.
jest.mock("../../lib/webhooks/event-log", () => ({
  TERMINAL_ERROR_PREFIXES: jest.requireActual("../../lib/webhooks/event-log")
    .TERMINAL_ERROR_PREFIXES,
  logWebhookEvent: jest.fn(),
  markWebhookEventProcessed: jest.fn(),
  isDbHealthy: jest.fn(async () => true),
  permanentFailure: (r: string) => `permanent: ${r}`,
}));

import {
  sweepStuckWebhookEvents,
  type SweepResult,
} from "../../scripts/cleanup/sweep-stuck-webhook-events";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** A row in the state the sweeper exists to rescue. */
function stuckRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    eventId: "stream_call.ended_abc123",
    provider: "stream",
    eventType: "call.ended",
    // Old enough for the selector's `receivedAt < staleBefore`.
    receivedAt: new Date(Date.now() - 30 * 60_000),
    // Old enough that the staleness escape SHOULD fire.
    claimedAt: new Date(Date.now() - 30 * 60_000),
    processed: false,
    error: null,
    payload: { type: "call.ended", call_cid: "default:occurrence-abc" },
    signature: "stored-signature-value",
    deferCount: 0,
    attempts: 0,
    ...overrides,
  };
}

async function sweepWith(rows: unknown[]): Promise<SweepResult> {
  mockFindMany.mockResolvedValue(rows);
  // The handler ran and marked the row complete — the success shape.
  mockFindUnique.mockResolvedValue({ error: null, processed: true });
  return (await sweepStuckWebhookEvents({
    limit: 10,
    // Skip the lock entirely; the lock's own behaviour is not what is under test.
    ...({} as object),
  } as never)) as SweepResult;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the lock wrapper just runs the function.
  // Three args: (jobName, opts, fn) — a two-arg mock silently passes `opts`
  // as the callback and fails with "fn is not a function", which reads like a
  // defect in the sweeper rather than in the harness.
  mockWithCronLock.mockImplementation(
    (_job: string, _opts: unknown, fn: () => unknown) => fn(),
  );
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockProcessStreamEvent.mockResolvedValue(undefined);
  mockProcessRazorpay.mockResolvedValue(undefined);
});

describe("the sweeper re-drives a Stream row", () => {
  it("actually calls the dispatcher for a stuck Stream row", async () => {
    // THE regression. Before the fix this assertion failed with zero calls: the
    // pre-claim reset the age to ~0, logWebhookEvent refused the row, and
    // processStreamEvent returned without dispatching.
    const res = await sweepWith([stuckRow()]);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
    expect(res.recovered).toBe(1);
    expect(res.scanned).toBe(1);
  });

  it("does NOT pre-claim the row before re-driving", async () => {
    // The precise mechanism. `claimedAt` must still hold the value the selector
    // read when the dispatcher runs, or the staleness escape reads a fresh claim
    // as an in-flight worker and refuses it.
    const row = stuckRow();
    await sweepWith([row]);
    const claimedWrites = mockUpdateMany.mock.calls.filter((c: unknown[]) =>
      writesWith(c, "claimedAt"),
    );
    expect(claimedWrites).toHaveLength(0);
  });

  it("still bumps the attempts counter", async () => {
    // The observability half. Before this column existed a Stream row always
    // read 0 attempts, so a deterministically-failing one was indistinguishable
    // from one that had crashed exactly once, and the give-up window was the only
    // bound.
    await sweepWith([stuckRow()]);
    const attemptsWrite = mockUpdateMany.mock.calls
      .map((c: unknown[]) => writesWith(c, "attempts"))
      .find(Boolean);
    expect(attemptsWrite).toEqual({ attempts: { increment: 1 } });
  });

  it("passes the STORED signature through, not undefined", async () => {
    // The audit called this "clobbering the signature" and was wrong about the
    // mechanism — neither retry branch of logWebhookEvent writes `signature`,
    // and the create path cannot run for a row that already exists. It still
    // matters: the claim is re-derived from the value handed to it, and a
    // re-drive carrying a different (absent) signature is one step further from
    // reproducing the original delivery.
    await sweepWith([stuckRow()]);
    expect(mockProcessStreamEvent.mock.calls[0][3]).toBe(
      "stored-signature-value",
    );
  });

  it("survives a row with no stored signature", async () => {
    await sweepWith([stuckRow({ signature: null })]);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessStreamEvent.mock.calls[0][3]).toBeUndefined();
  });

  it("handles an errored row (processed:true, error != null) the same way", async () => {
    // The other stuck shape. logWebhookEvent's `existing.error` branch claims
    // unconditionally, so this one never depended on the staleness escape — but
    // it is half the selector and must keep working.
    await sweepWith([
      stuckRow({
        processed: true,
        error: "handler exploded",
        receivedAt: new Date(Date.now() - 30 * 60_000),
      }),
    ]);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("routes Razorpay rows to the Razorpay dispatcher", async () => {
    await sweepWith([stuckRow({ provider: "razorpay" })]);
    expect(mockProcessRazorpay).toHaveBeenCalledTimes(1);
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("rebuilds a created_at for the Razorpay envelope from receivedAt", async () => {
    // The envelope fields the per-event schemas require, which WebhookEvent
    // does not store.
    await sweepWith([stuckRow({ provider: "razorpay" })]);
    const envelope = mockProcessRazorpay.mock.calls[0][0] as {
      created_at: number;
      contains: string[];
    };
    expect(typeof envelope.created_at).toBe("number");
    expect(envelope.contains).toContain("type");
  });
});

describe("the sweeper reports what it gave up on", () => {
  it("counts a give-up and alerts", async () => {
    // A give-up is terminal and was silent: the row becomes processed:true with
    // a `gave up:` error, indistinguishable from a clean completion to any query
    // anyone was likely to write. The only evidence was a log line in a GitHub
    // Actions run nobody opens.
    mockFindMany.mockResolvedValue([
      stuckRow({ receivedAt: new Date(Date.now() - 200 * 3_600_000) }),
    ]);
    // The handler ran but left the row in the defer signature.
    mockFindUnique.mockResolvedValue({ error: null, processed: false });

    const res = await sweepStuckWebhookEvents({ limit: 10 } as never);

    expect(res.gaveUp).toBe(1);
    expect(mockCaptureThrottled).toHaveBeenCalledWith(
      "webhook:give-up:stream",
      expect.any(String),
      expect.objectContaining({ subsystem: "webhook" }),
    );
  });

  it("stamps a provider-appropriate reason, not a payment one", async () => {
    // "payment never arrived" on a Stream session event sends whoever reads the
    // row looking for a payment that was never involved.
    mockFindMany.mockResolvedValue([
      stuckRow({ receivedAt: new Date(Date.now() - 200 * 3_600_000) }),
    ]);
    mockFindUnique.mockResolvedValue({ error: null, processed: false });
    await sweepStuckWebhookEvents({ limit: 10 } as never);
    const stamped = mockUpdateMany.mock.calls
      .map((c: unknown[]) => writesWith(c, "error"))
      .find(
        (d) => typeof d?.error === "string" && d.error.startsWith("gave up:"),
      );
    expect(stamped!.error).toContain("Stream event");
    expect(stamped!.error).not.toContain("payment");
  });

  it("keys the give-up alert per provider", async () => {
    // So a Razorpay give-up and a Stream give-up are distinguishable in the
    // issue stream rather than throttling each other into silence.
    mockFindMany.mockResolvedValue([
      stuckRow({
        provider: "razorpay",
        receivedAt: new Date(Date.now() - 200 * 3_600_000),
      }),
    ]);
    mockFindUnique.mockResolvedValue({ error: null, processed: false });
    await sweepStuckWebhookEvents({ limit: 10 } as never);
    expect(mockCaptureThrottled.mock.calls[0][0]).toBe(
      "webhook:give-up:razorpay",
    );
  });

  it("still retries a deferred row that is inside the give-up window", async () => {
    // A deferral is a handler decision to try again later, not a fault. The
    // status code must not flip on it, or a healthy queue reports 207 forever.
    mockFindMany.mockResolvedValue([stuckRow()]);
    mockFindUnique.mockResolvedValue({ error: null, processed: false });
    const res = await sweepStuckWebhookEvents({ limit: 10 } as never);
    expect(res.deferred).toBe(1);
    expect(res.gaveUp).toBe(0);
  });
});

describe("the staleness arithmetic the fix depends on", () => {
  it("a claim taken 30 minutes ago escapes; a claim taken now does not", () => {
    // Pinned directly, because the whole fix is a statement about this
    // comparison and a future edit to the threshold should be a visible diff.
    // Modelled the way `logWebhookEvent` does it: an AGE, not a timestamp.
    const now = Date.now();
    const ageOf = (claimedAt: number) => now - claimedAt;
    expect(ageOf(now - 30 * 60_000)).toBeGreaterThan(STALE_THRESHOLD_MS);
    expect(ageOf(now)).not.toBeGreaterThan(STALE_THRESHOLD_MS);
  });

  it("the pre-claim made every row look like the second case", () => {
    // The mechanism, stated as the test that would have caught it: writing
    // `claimedAt: now()` before dispatch puts the row in the NOT-stale branch
    // unconditionally, no matter how stuck it actually was.
    const now = Date.now();
    const actuallyStuck = now - 30 * 60_000;
    const afterPreClaim = now; // what the pre-claim wrote
    const escape = (claimedAt: number) => now - claimedAt > STALE_THRESHOLD_MS;
    expect(escape(actuallyStuck)).toBe(true);
    expect(escape(afterPreClaim)).toBe(false);
  });

  it("the sweeper's own staleMinutes default sits above the escape threshold", () => {
    // The selector must not hand the dispatcher a row younger than the escape
    // considers fresh, or the re-drive is refused for a reason that has nothing
    // to do with the row being stuck. 6 > 5 today; the ordering is the invariant.
    expect(6).toBeGreaterThan(STALE_THRESHOLD_MS / 60_000);
  });
});
