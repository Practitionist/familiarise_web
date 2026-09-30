/**
 * @jest-environment node
 */

/**
 * #1829 — the dedup gate and the replay window, tested at the ROUTE.
 *
 * Why this file exists at all: `app/api/stream/webhooks/route.ts` had ZERO test
 * importers before this. Everything the route does — the gzip magic-byte sniff,
 * the 401, the 413 on an oversize body, the 503 when the receipt cannot be
 * written, and above all the dedup decision — was therefore untestable, because
 * importing the module pulls in the whole dispatcher and its Prisma graph.
 *
 * The three facts that made the P0 invisible are each pinned below:
 *
 *   1. The dedup key and its `@unique` constraint were both correct and both
 *      gated nothing, because `recordStreamEventReceipt` returned `void` and the
 *      only dispatch path passed `claimAlreadyHeld: true`, whose entire purpose
 *      is to SKIP the `isNew` check.
 *   2. The sweeper's pre-claim reset `claimedAt` to now(), so `logWebhookEvent`'s
 *      staleness escape read the age as ~0 and refused the row the sweeper
 *      exists to rescue.
 *   3. A correctly-signed OLD body replayed forever: `created_at` was parsed
 *      into the schema and then read only as a sink value.
 *
 * Stream's own documentation tells integrators to "deduplicate on the ID rather
 * than on event contents". We key on `sha256(body)` instead, because Stream signs
 * the body and NOT the `X-Webhook-Id` header — one captured `(body, signature)`
 * pair would replay under N invented header values and mint N dispatches. That
 * is a deliberate deviation from the vendor's guidance, so the reasoning is
 * tested here as well as asserted in the source, so that a future editor
 * "correcting" it back has to delete a test that explains why.
 */

const mockLogWebhookEvent = jest.fn();
const mockMarkProcessed = jest.fn();
const mockRecordReceipt = jest.fn();
const mockProcessStreamEvent = jest.fn();
const mockIsDbHealthy = jest.fn();
const mockCaptureThrottled = jest.fn();

/**
 * Relative paths, NOT the `@/` alias. The alias resolves to a different module
 * instance under jest, so the mock silently fails to bind and the symptom is
 * indistinguishable from a bad fixture — a fact already paid for once in
 * `webhook-durability.test.ts`, which is why the note is repeated here.
 */
jest.mock("../../lib/webhooks/event-log", () => ({
  TERMINAL_ERROR_PREFIXES: jest.requireActual("../../lib/webhooks/event-log")
    .TERMINAL_ERROR_PREFIXES,
  logWebhookEvent: (...a: unknown[]) => mockLogWebhookEvent(...a),
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => mockIsDbHealthy(),
  permanentFailure: (reason: string) => `permanent: ${reason}`,
}));

jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: (...a: unknown[]) => mockCaptureThrottled(...a),
  resetThrottledCaptureForTesting: () => {},
}));

/**
 * The handler modules are mocked BEFORE the dispatcher is required, and that
 * ordering is load-bearing rather than incidental. `webhook-dispatch` imports the
 * recording and session handlers at module scope, each of which imports
 * `lib/prisma` at module scope, so a `requireActual` of the dispatcher without
 * these in place opens a real connection attempt and the route answers 500 for
 * reasons that have nothing to do with the assertion under test. Every failure
 * in this file looked identical until the handlers were stubbed.
 */
jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: jest.fn(),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: jest.fn(),
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

// The dispatcher is loaded for real so the replay classifier and the event-type
// registry are the shipped ones; only the two I/O entry points are replaced.
jest.mock("../../lib/stream/webhook-dispatch", () => ({
  ...(jest.requireActual("../../lib/stream/webhook-dispatch") as object),
  recordStreamEventReceipt: (...a: unknown[]) => mockRecordReceipt(...a),
  processStreamEvent: (...a: unknown[]) => mockProcessStreamEvent(...a),
}));

// The route reaches the real `stream-chat` verifier on purpose: the property
// under test is that the dedup key derives from SIGNATURE-COVERED material, so
// stubbing verification would let the suite pass even if the route keyed on a
// header instead.

import { POST } from "../../app/api/stream/webhooks/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-api-secret";

function signed(
  headers: Record<string, string>,
  body: string | Buffer,
): Request {
  return new Request("https://example.test/api/stream/webhooks", {
    method: "POST",
    headers,
    body: body as BodyInit,
  });
}

function callEndedEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "call.ended",
    call_cid: "default:occurrence-abc",
    created_at: new Date().toISOString(),
    call: {
      cid: "default:occurrence-abc",
      ended_at: new Date().toISOString(),
      custom: { sessionStartsAt: "x" },
    },
    ...overrides,
  });
}

/**
 * The signature is computed the way the SDK does — HMAC-SHA256 over the body,
 * hex. Computing it here rather than stubbing `verifySignature` is deliberate:
 * the property under test is that the ROUTE's key comes from signature-covered
 * material, and a stubbed verifier would make the test pass even if the route
 * derived that key from a header instead.
 */
function sign(body: string | Buffer, secret = SECRET): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto")
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
}

async function deliver(
  body: string,
  opts: { secret?: string; id?: string } = {},
) {
  const headers: Record<string, string> = {
    "x-signature": sign(body, opts.secret ?? SECRET),
  };
  if (opts.id) headers["x-webhook-id"] = opts.id;
  return POST(signed(headers, body) as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STREAM_API_SECRET = SECRET;
  delete process.env.STREAM_WEBHOOK_SECRET;
  mockIsDbHealthy.mockResolvedValue(true);
  // A genuinely new delivery is the default; each test overrides as needed.
  mockRecordReceipt.mockResolvedValue({
    isNew: true,
    claim: { claimedAt: null },
  });
  mockMarkProcessed.mockResolvedValue(undefined);
  mockProcessStreamEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. The dedup gate — the P0
// ---------------------------------------------------------------------------

describe("the dedup gate", () => {
  it("dispatches a first delivery", async () => {
    const body = callEndedEvent();
    const res = await deliver(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ accepted: true });
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispatch a duplicate delivery", async () => {
    // The regression this whole file is named for. Before the fix the route had
    // no way to learn it had seen the event, so a duplicate was acknowledged
    // AND fully re-dispatched — attendance re-upserted, recordings re-created,
    // notifications re-staged.
    mockRecordReceipt.mockResolvedValue({
      isNew: false,
      claim: { claimedAt: null },
    });
    const body = callEndedEvent();
    const res = await deliver(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ duplicate: true });
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("answers 200 on a duplicate, not 5xx", async () => {
    // A 5xx would spend three of Stream's five attempts re-asking a question we
    // have a durable row answering.
    mockRecordReceipt.mockResolvedValue({
      isNew: false,
      claim: { claimedAt: null },
    });
    const res = await deliver(callEndedEvent());
    expect(res.status).toBe(200);
  });

  it("collapses a byte-identical replay under N DIFFERENT webhook ids", async () => {
    // The property the sha256 key is bought for, and the exact reason we deviate
    // from Stream's "deduplicate on the id" guidance. `X-Webhook-Id` is not
    // covered by the signature, so a captured (body, signature) pair replays
    // under any header value the attacker likes. Under an id-keyed scheme this
    // would be three dispatches; the key is derived from the signed body alone,
    // so `logWebhookEvent`'s unique constraint collapses all three.
    const body = callEndedEvent();
    const ids = ["wh-1", "wh-attacker-a", "wh-attacker-b"];
    const keys = new Set<string>();
    for (const id of ids) {
      await deliver(body, { id });
      // The key handed to the event log is the same for all three deliveries.
      keys.add(mockRecordReceipt.mock.calls[keys.size]?.[0]);
    }
    expect(keys.size).toBe(1);
  });

  it("derives the key from the body, not from a header", async () => {
    // Pin the derivation itself, so a future edit that prefers X-Webhook-Id
    // cannot pass.
    const body = callEndedEvent();
    await deliver(body, { id: "wh-1" });
    const key = mockRecordReceipt.mock.calls[0][0] as string;
    expect(key.startsWith("stream_call.ended_")).toBe(true);
    expect(key).not.toContain("wh-1");
  });

  it("does not collapse two genuinely different events", async () => {
    // The counter-case: `created_at` alone must not be the key, or two distinct
    // ends in the same second would collide and one would vanish.
    await deliver(callEndedEvent({ call: { cid: "default:occurrence-abc" } }));
    await deliver(callEndedEvent({ call: { cid: "default:occurrence-xyz" } }));
    const keys = mockRecordReceipt.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
  });

  it("hands the completion mark a claim so it is fenced", async () => {
    // Both callers used to arrive with no fence: the route's because
    // `claimAlreadyHeld` skipped the assignment, the sweeper's because it never
    // claimed at all. So `markWebhookEventProcessed` took the unfenced branch on
    // every Stream event in the system.
    mockRecordReceipt.mockResolvedValue({
      isNew: true,
      claim: { claimedAt: new Date("2026-09-30T00:00:00.000Z") },
    });
    await deliver(callEndedEvent());
    const opts = mockProcessStreamEvent.mock.calls[0][5] as Record<
      string,
      unknown
    >;
    expect(opts.claim).toEqual({
      claimedAt: new Date("2026-09-30T00:00:00.000Z"),
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The replay window
// ---------------------------------------------------------------------------

describe("the replay window", () => {
  it("accepts a fresh delivery", async () => {
    const res = await deliver(callEndedEvent());
    expect(res.status).toBe(200);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts a delivery inside Stream's whole 15s retry budget", async () => {
    // The window must never be near a genuine retry. Stream allows 6s per
    // attempt inside 15s total.
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 14_000).toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(200);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses a correctly-signed OLD body and does not dispatch it", async () => {
    // The P1. `created_at` was parsed into the schema and then read only as a
    // sink value, so a replayed old `session_participant_joined` took the CREATE
    // branch of the attendance upsert and stamped an ancient firstJoinedAt —
    // which is the input to the no-show classifier and the review gate.
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accepted: false,
      reason: "replay_window",
    });
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("records the refusal so the decision is auditable", async () => {
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    await deliver(body);
    expect(mockRecordReceipt).toHaveBeenCalledTimes(1);
    // The claim is passed through, so the stamp is CAS'd on the row this
    // delivery actually created rather than an unfenced `update` by eventId.
    expect(mockMarkProcessed).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("permanent: replay_window_exceeded"),
      { claimedAt: null },
    );
  });

  // #1829 — a REPLAY of a delivery that was already recorded must not rewrite
  // that row. `isNew: false` means the exact body was seen before, typically
  // fully processed; stamping it unfenced relabelled a handled delivery as a
  // permanent failure in the row an operator and an auditor read.
  it("leaves an already-recorded delivery's row untouched on a replay", async () => {
    mockRecordReceipt.mockResolvedValue({
      isNew: false,
      claim: { claimedAt: null },
    });
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });

    const res = await deliver(body);

    // Still refused, still terminal — the delivery is genuinely out of window.
    expect(res.status).toBe(200);
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it("does not stamp the refusal when the receipt itself reports a duplicate", async () => {
    // Same guard, asserted through the argument list rather than the response,
    // so a future refactor that keeps the status but drops the guard fails here.
    mockRecordReceipt.mockResolvedValue({
      isNew: false,
      claim: { claimedAt: null },
    });
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });

    await deliver(body);

    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it("marks a refusal terminal so the sweeper never re-drives it", async () => {
    // `permanent:` is the prefix the sweeper's selector reads to exclude a row.
    // Without it the refusal would be re-selected every sweep for 168 hours.
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    await deliver(body);
    const reason = mockMarkProcessed.mock.calls[0][1] as string;
    expect(reason.startsWith("permanent:")).toBe(true);
  });

  it("refuses a created_at far in the future", async () => {
    // Either a forged stamp or a sender whose clock has drifted. Either way it
    // breaks firstJoinedAt, and a negative age sails past every comparison a
    // forward-skew tolerance would otherwise allow.
    const body = callEndedEvent({
      created_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const res = await deliver(body);
    await expect(res.json()).resolves.toMatchObject({
      reason: "replay_window",
    });
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("tolerates ordinary forward clock skew", async () => {
    const body = callEndedEvent({
      created_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(200);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses an unparseable created_at rather than skipping the check", async () => {
    // NaN fails every comparison, so a naive `age > window` test would sail
    // through and let a malformed stamp act on the event.
    const body = callEndedEvent({ created_at: "not-a-date" });
    const res = await deliver(body);
    await expect(res.json()).resolves.toMatchObject({
      reason: "replay_window",
    });
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. The 401 that is final to Stream
// ---------------------------------------------------------------------------

describe("signature failure", () => {
  it("answers 401 on a bad signature", async () => {
    const body = callEndedEvent();
    const res = await POST(
      signed({ "x-signature": "deadbeef" }, body) as never,
    );
    expect(res.status).toBe(401);
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("PAGES on a bad signature", async () => {
    // 401 is not in Stream's retryable set (408/429/5xx) and a rejection is
    // never written to a failover bucket, so the event is gone the moment we
    // answer. It used to be a bare `console.warn`, which
    // `lib/health/probe.ts` documents is stripped from the function log — so a
    // mis-set secret produced zero Sentry events, a green /api/health, and total
    // silent loss. That is the 2026-08-12 outage.
    const res = await POST(
      signed({ "x-signature": "deadbeef" }, callEndedEvent()) as never,
    );
    expect(res.status).toBe(401);
    expect(mockCaptureThrottled).toHaveBeenCalledWith(
      "stream:webhook-signature",
      expect.any(String),
      expect.objectContaining({ subsystem: "stream" }),
    );
  });

  it("says whether a secret override is set, so the fix is one line", async () => {
    process.env.STREAM_WEBHOOK_SECRET = "wrong-value";
    await POST(
      signed({ "x-signature": "deadbeef" }, callEndedEvent()) as never,
    );
    const opts = mockCaptureThrottled.mock.calls[0][2] as {
      extra: { hasOverride: boolean };
    };
    expect(opts.extra.hasOverride).toBe(true);
  });

  it("never leaks secret material into the report", async () => {
    process.env.STREAM_WEBHOOK_SECRET = "super-secret-value";
    process.env.STREAM_API_SECRET = "also-secret";
    await POST(
      signed({ "x-signature": "deadbeef" }, callEndedEvent()) as never,
    );
    const serialised = JSON.stringify(mockCaptureThrottled.mock.calls[0]);
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("also-secret");
  });

  it("rejects a missing x-signature header", async () => {
    const res = await POST(signed({}, callEndedEvent()) as never);
    expect(res.status).toBe(401);
  });

  it("rejects a body signed with a different secret", async () => {
    const res = await deliver(callEndedEvent(), { secret: "attacker" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. The bounded body read
// ---------------------------------------------------------------------------

describe("the body cap", () => {
  it("answers 413, not 401 or 5xx, on an oversize body", async () => {
    // 5xx would spend three of five attempts on a body that cannot succeed; 401
    // would read as a signature fault we deliberately page on.
    const huge = "x".repeat(300 * 1024);
    const res = await deliver(huge);
    expect(res.status).toBe(413);
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("still handles a normal payload", async () => {
    const res = await deliver(callEndedEvent());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. gzipped delivery — the reason the bytes primitive exists
// ---------------------------------------------------------------------------

describe("gzipped delivery", () => {
  it("verifies against the INFLATED bytes, as Stream signs them", async () => {
    const { gzipSync } = await import("node:zlib");
    const body = callEndedEvent();
    const compressed = gzipSync(Buffer.from(body, "utf8"));
    // Sanity: the magic bytes are what the sniff looks for.
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);

    const res = await POST(
      signed(
        { "x-signature": await sign(body) },
        Buffer.from(compressed),
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(mockProcessStreamEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a gzipped body whose signature was taken over the COMPRESSED bytes", async () => {
    // Which is why the route cannot use the text helper: decoding binary through
    // UTF-8 replaces every byte above 0x7F with U+FFFD, so the magic prefix would
    // survive only by accident.
    const { gzipSync } = await import("node:zlib");
    const compressed = gzipSync(Buffer.from(callEndedEvent(), "utf8"));
    const res = await POST(
      signed(
        { "x-signature": await sign(compressed.toString("base64")) },
        Buffer.from(compressed),
      ) as never,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 6. Unhandled types and a failed receipt
// ---------------------------------------------------------------------------

describe("other route outcomes", () => {
  it("acknowledges an unhandled event type without recording a row", async () => {
    const body = JSON.stringify({
      type: "call.permission_request",
      call_cid: "default:occurrence-abc",
      created_at: new Date().toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ handled: false });
    expect(mockRecordReceipt).not.toHaveBeenCalled();
  });

  it("answers 503 when an OUT-OF-WINDOW receipt cannot be written", async () => {
    // #1829 — the promise-form regression. The refusal path was
    // `recordStreamEventReceipt(...).then(mark).catch(() => return
    // NextResponse(503))`, and a `return` inside a `.catch` callback resolves
    // the CHAIN with that value, which the `await` then discarded — so execution
    // fell through to the 200 below. Stream treats 2xx as final, nothing was
    // recorded, and the sweeper had no row to re-drive: the one shape where a
    // failed write loses the event permanently, silently, while the comment
    // directly above it claimed it was handled.
    //
    // The happy-path refusal case below passed the whole time, which is why a
    // 44-case suite for this route did not catch it.
    mockRecordReceipt.mockRejectedValue(new Error("pool exhausted"));
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(503);
  });

  it("answers 503 when the out-of-window COMPLETION mark cannot be written", async () => {
    // Same path, second write. Distinct because the first can succeed and the
    // second fail, leaving a row in IN-PROGRESS that the sweeper would re-drive
    // — for an event we deliberately refused. Terminal must mean terminal.
    mockRecordReceipt.mockResolvedValue({
      isNew: true,
      claim: { claimedAt: null },
    });
    mockMarkProcessed.mockRejectedValue(new Error("connection reset"));
    const body = callEndedEvent({
      created_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    const res = await deliver(body);
    expect(res.status).toBe(503);
  });

  it("answers 503 when the receipt cannot be written", async () => {
    // The one case that deserves a retryable answer, because nothing was
    // recorded so Stream's redelivery is the only remaining chance.
    mockRecordReceipt.mockRejectedValue(new Error("pool exhausted"));
    const res = await deliver(callEndedEvent());
    expect(res.status).toBe(503);
    expect(mockProcessStreamEvent).not.toHaveBeenCalled();
  });

  it("answers 500 when no secret is configured at all", async () => {
    delete process.env.STREAM_API_SECRET;
    delete process.env.STREAM_WEBHOOK_SECRET;
    const res = await POST(
      signed({ "x-signature": "x" }, callEndedEvent()) as never,
    );
    expect(res.status).toBe(500);
  });

  it("falls back to STREAM_API_SECRET when no override is set", async () => {
    // Stream signs with the API secret; there is no separate signing secret in
    // their dashboard. Requiring a distinct one 500'd every delivery.
    delete process.env.STREAM_WEBHOOK_SECRET;
    const res = await deliver(callEndedEvent());
    expect(res.status).toBe(200);
  });
});
