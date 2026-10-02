/**
 * @jest-environment node
 */

/**
 * #C2 — the orphan reconciler may only close a row on a CONFIRMED end.
 *
 * The job finds `Meeting` rows with `endedAt: null` whose slot ended over an
 * hour ago and asks Stream whether the call had ended. When Stream answered "no
 * `ended_at` yet" the job used to write `endedAt = occurrence.endsAt` with
 * `endedReason: "reconciled_no_end"` — a past timestamp, taken from the
 * CALENDAR, stamped onto a call that was still running. A consultation that
 * overran its slot, or a room the consultant had just closed and Stream had not
 * published `ended_at` for, was recorded as finished while people were in it.
 *
 * That is worse than a wrong label, because `Meeting.endedAt` is the END CAS:
 * `supersedesRecordedEnd` in lib/stream/session-handlers.ts refuses to move it
 * backwards, so the false stamp cannot be corrected by the real end that arrives
 * later. `drain-sessions.ts:231` reached the same conclusion from the other side
 * — "only record the session as ended if Stream CONFIRMED it" — and this job now
 * matches it.
 *
 * The second half of the defect is quieter: once "Stream says still open" is a
 * legitimate outcome, such a row matches the selector on every run forever. With
 * a single `take: 100` and no `orderBy`, a hundred of them would starve every
 * other row in the table, so the job pages with a cursor and bounds itself by
 * Stream LOOKUPS rather than by rows read.
 */

const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockCallGet = jest.fn();
let mockStreamConfigured = true;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(),
}));

jest.mock("../../lib/observability/job-sentry", () => ({
  runJob: (_name: string, fn: () => unknown) => fn,
}));

jest.mock("@sentry/nextjs", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  captureException: jest.fn(),
}));

// #1829 — the REAL error classifiers, not a mock of them. This suite's whole
// point is the structured 404 check, and mocking the classifier is what let
// `isCallMissing` read a field the video SDK does not have while the test
// modelled the same wrong field: two errors cancelling, so the branch read as
// covered when it was dead code in production.
//
// The actual module is spread FIRST so the client/breaker stubs below win —
// requireActual carries a real `getStreamVideoClient` that would otherwise open
// a live Stream client mid-test.
jest.mock("../../lib/stream-client", () => ({
  ...jest.requireActual("../../lib/stream-client"),
  isStreamConfigured: () => mockStreamConfigured,
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  getStreamVideoClient: () => ({
    video: { call: () => ({ get: () => mockCallGet() }) },
  }),
}));

import {
  reconcileOrphanedSessions,
  type ReconciliationResult,
} from "../../jobs/meetings/reconcile-orphaned-sessions";

const SLOT_END = new Date("2026-09-13T11:00:00.000Z");

/**
 * An error shaped exactly as `@stream-io/node-sdk` throws one.
 *
 * From the SDK's own throw site: `new StreamError(message, metadata, code)`
 * where `metadata.responseCode` is `response.status`. `StreamError` defines only
 * `metadata` and `code`, so there is no `status` and no `statusCode`.
 */
const streamError = (responseCode: number, code?: number) =>
  Object.assign(new Error(`Stream error: ${responseCode}`), {
    metadata: { responseCode, responseHeaders: new Map() },
    ...(code === undefined ? {} : { code }),
  });

const session = (id: string, callType = "default") => ({
  id,
  streamCallId: `occurrence-${id}`,
  // Every Meeting row carries it — NOT NULL with a default, so a fixture that
  // omits it models a row that cannot exist. It matters here because the job
  // reads the type off the row to know which call to ask Stream about, and
  // refuses to treat a 404 as conclusive unless it asked the type the row names.
  callType,
  occurrence: { endsAt: SLOT_END },
});

/** Stream's answer for a call that is over. */
const ended = (at: string) => ({ call: { ended_at: at } });
/** Stream's answer for a room with nobody in it that has not been closed. */
const stillOpen = { call: { ended_at: null } };

beforeEach(() => {
  jest.clearAllMocks();
  mockStreamConfigured = true;
  mockFindMany.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockCallGet.mockResolvedValue(ended("2026-09-13T11:30:00.000Z"));
});

const run = (): Promise<ReconciliationResult> => reconcileOrphanedSessions();

describe("a live call is not stamped as finished (C2)", () => {
  it("writes NOTHING when Stream says the room has not ended", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockResolvedValue(stillOpen);

    const result = await run();

    // The assertion that matters: the slot's end is not a fact about the call.
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result.unconfirmed).toBe(1);
    expect(result.reconciled).toBe(0);
    // Not an error either — this is the job working, reporting a row it declined
    // to guess about.
    expect(result.success).toBe(true);
    expect(result.details.join("\n")).toMatch(/still open/);
  });

  it("leaves the row open when Stream cannot answer at all", async () => {
    // A timeout, a socket reset, an open circuit. The old code counted these as
    // `stream_not_found` and stamped the slot end on all of them, so one bad
    // minute of provider latency closed out every row in the batch.
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockRejectedValue(new Error("socket hang up"));

    const result = await run();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result.unconfirmed).toBe(1);
    expect(result.streamNotFound).toBe(0);
  });

  it("leaves the row open when the circuit breaker is open", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    const { StreamUnavailableError } = jest.requireActual<
      typeof import("../../lib/stream-client")
    >("../../lib/stream-client");
    mockCallGet.mockRejectedValue(new StreamUnavailableError());

    const result = await run();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result.unconfirmed).toBe(1);
  });

  it("re-checks the same row on the next run rather than giving up on it", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockResolvedValue(stillOpen);
    await run();
    // Second run: the call has since been closed for real.
    mockCallGet.mockResolvedValue(ended("2026-09-13T12:00:00.000Z"));

    const result = await run();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ms-1", endedAt: null },
      data: {
        endedAt: new Date("2026-09-13T12:00:00.000Z"),
        endedReason: "reconciled",
      },
    });
    expect(result.reconciled).toBe(1);
  });
});

describe("a confirmed end is still stamped", () => {
  it("takes Stream's own ended_at, CAS on the open row", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockResolvedValue(ended("2026-09-13T11:30:00.000Z"));

    const result = await run();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      // The CAS: a webhook or the drain that closed the room meanwhile wins, and
      // this job must not overwrite it.
      where: { id: "ms-1", endedAt: null },
      data: {
        endedAt: new Date("2026-09-13T11:30:00.000Z"),
        endedReason: "reconciled",
      },
    });
    expect(result.reconciled).toBe(1);
    expect(result.unconfirmed).toBe(0);
  });

  it("closes a row whose call is definitively gone (404)", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockRejectedValue(streamError(404));

    const result = await run();

    // A call that does not exist cannot be live, so this is the one error that
    // justifies writing — and the only signal trusted is the structured status,
    // not a message probe.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ms-1", endedAt: null },
      data: { endedAt: SLOT_END, endedReason: "stream_not_found" },
    });
    expect(result.streamNotFound).toBe(1);
    expect(result.unconfirmed).toBe(0);
  });

  // #1829 — this suite exercises the REAL `isCallMissing` (it does not mock
  // `lib/stream-client`), so the error it throws has to be the error the video
  // SDK actually throws. It modelled a 404 as `{ statusCode: 404 }`, which is
  // the Razorpay/Stripe idiom, and the classifier read that same field — so the
  // two mistakes cancelled and the test passed. Against a real `StreamError`
  // neither field exists and the whole branch was dead code in production.
  it("recognises a 404 in the shape @stream-io/node-sdk really throws", async () => {
    mockFindMany.mockResolvedValue([session("ms-1")]);
    const thrown = streamError(404);

    // Belt and braces: assert the fixture is what we claim it is, so a future
    // edit to the helper cannot quietly turn this back into a passing fiction.
    expect(thrown).not.toHaveProperty("status");
    expect(thrown).not.toHaveProperty("statusCode");
    expect(
      (thrown as { metadata: { responseCode: number } }).metadata.responseCode,
    ).toBe(404);

    mockCallGet.mockRejectedValue(thrown);

    const result = await run();

    expect(result.streamNotFound).toBe(1);
  });

  it("does NOT close a row on an error that is not a 404", async () => {
    // A 500 is not evidence the call is gone, and writing a past `endedAt` on
    // one would close a live call's row — the over-eager behaviour this
    // structured check was introduced to prevent.
    mockFindMany.mockResolvedValue([session("ms-1")]);
    mockCallGet.mockRejectedValue(streamError(500, 4));

    const result = await run();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result.streamNotFound).toBe(0);
    expect(result.unconfirmed).toBe(1);
  });
});

describe("the batch is ordered and bounded (C2)", () => {
  /** A row per page, so the cursor can be asserted rather than assumed. */
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => session(`ms-${from + i}`));

  it("reads the most overdue rows first, with a stable tiebreak", async () => {
    await run();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          endedAt: null,
          occurrence: { endsAt: { lt: expect.any(Date) } },
        },
        // Oldest end first: the row that has been waiting longest is the one a
        // dashboard is still showing as live. `id` is the tiebreak because
        // cursor paging over a non-unique order can repeat or skip rows.
        orderBy: [{ occurrence: { endsAt: "asc" } }, { id: "asc" }],
        take: 100,
      }),
    );
  });

  it("pages past a full page of rows it declined to write", async () => {
    // Every row on the first page is a live call, which is a legitimate
    // "nothing to do". With one `take: 100` those rows would be returned forever
    // and nothing behind them would ever be examined.
    mockFindMany
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 100))
      .mockResolvedValueOnce(page(200, 100));
    mockCallGet.mockResolvedValue(stillOpen);

    const result = await run();

    // Two pages read, and no more: the third exists, and the lookup budget
    // (200) is spent. The rows behind it are the NEXT run's work, which is the
    // trade the original `take` was making about Stream timeouts (#473) — kept,
    // but counted in lookups rather than in rows.
    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(mockFindMany.mock.calls[1][0]).toMatchObject({
      cursor: { id: "ms-99" },
      skip: 1,
    });
    expect(result.processed).toBe(200);
    expect(result.unconfirmed).toBe(200);
    expect(result.details.join("\n")).toMatch(/budget reached/);
  });

  it("stops paging once a short page proves the set is exhausted", async () => {
    mockFindMany
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 7));
    mockCallGet.mockResolvedValue(ended("2026-09-13T11:30:00.000Z"));

    await run();

    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });
});

describe("with no provider there is nothing to reconcile against", () => {
  it("stamps nothing and says so, instead of inventing a slot end", async () => {
    mockStreamConfigured = false;

    const result = await run();

    // The old shape counted these under `streamNotFound` and wrote
    // `endedReason: "stream_not_configured"` on every row in the table.
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.details.join("\n")).toMatch(/not configured/);
  });
});
