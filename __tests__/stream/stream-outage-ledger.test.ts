/**
 * @jest-environment node
 */

/**
 * #E6 — a Stream outage produced NO `SystemEvent` row at all.
 *
 * `SystemEvent` is the table engineering reads when the dashboards are quiet,
 * and every Stream symptom lived somewhere else: no `WebhookEvent` rows, no
 * `MeetingAttendance` rows, a green `/api/health`, and — because `console.*` is
 * stripped from the Netlify function log (#1122) — no console line either. That
 * combination is the 2026-08-12 outage in full, and it is why this module
 * exists: the `STREAM` and `VIDEO` categories are worthless unless something
 * actually writes them.
 *
 * The writer is transition-gated because `/api/health` is polled every few
 * minutes. A row per poll would fill the table with one fact and make the table
 * useless for the transitions it exists to record.
 */

// Typed as a variadic mock rather than a zero-arg one: the cases below read
// `mock.calls.at(-1)[0]`, and a `() => void` signature makes that index access
// a type error.
const mockRecordSystemErrorSafe = jest.fn(
  async (..._args: unknown[]): Promise<void> => {},
);

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: (...args: unknown[]) =>
    mockRecordSystemErrorSafe(...args),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  recordStreamOutage,
  resetStreamOutageLedgerForTesting,
  STREAM_EVENT_CATEGORY,
  VIDEO_EVENT_CATEGORY,
} from "../../lib/stream/system-event";

const lastRow = () =>
  mockRecordSystemErrorSafe.mock.calls.at(-1)?.[0] as
    | {
        category: string;
        summary: string;
        err: Error;
        context?: Record<string, unknown>;
      }
    | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  resetStreamOutageLedgerForTesting();
});

describe("recordStreamOutage — transition-gated (#E6)", () => {
  it("writes one row for an outage start", async () => {
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });

    expect(mockRecordSystemErrorSafe).toHaveBeenCalledTimes(1);
    const row = lastRow()!;
    expect(row.category).toBe(STREAM_EVENT_CATEGORY);
    expect(row.summary).toContain("unreachable");
    expect(row.summary).toContain("UNREACHABLE");
    // `recordSystemError` has no `op` parameter, so the operation name travels
    // in `context` — recorded, not silently dropped.
    expect(row.context).toMatchObject({ op: "health.streamOutage" });
  });

  it("writes NOTHING for the same state on the next poll", async () => {
    // The whole reason it is gated. /api/health is polled every few minutes; a
    // row per poll would fill `system_events` with one fact and make the table
    // useless for the transitions it exists to record.
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });

    expect(mockRecordSystemErrorSafe).toHaveBeenCalledTimes(1);
  });

  it("writes a RECOVERY row when it comes back", async () => {
    // Without this, an operator cannot tell an outage that ended from one that
    // is still open — and "when did it come back" is the first question asked
    // of an incident timeline.
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: false,
      reason: "REACHABLE",
    });

    expect(mockRecordSystemErrorSafe).toHaveBeenCalledTimes(2);
    const row = lastRow()!;
    expect(row.summary).toContain("reachable again");
    expect(row.context).toMatchObject({
      recovering: true,
      reason: "REACHABLE",
    });
  });

  it("carries the coarse facts in `context`, never the raw SDK error", async () => {
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "CIRCUIT_OPEN",
      context: { breakerState: "OPEN", breakerFailures: 5 },
    });

    // The classification an operator can act on, not whatever the SDK said. A
    // Stream error message can echo channel ids, user ids and occasionally a
    // token, and `SystemEvent.context` is a JSON column anyone can query.
    expect(lastRow()!.context).toEqual({
      op: "health.streamOutage",
      reason: "CIRCUIT_OPEN",
      recovering: false,
      breakerState: "OPEN",
      breakerFailures: 5,
    });
  });

  it("tags the VIDEO category when asked", async () => {
    // Chat and video bill and fail separately, and a dashboard that only shows
    // the category cannot tell a video-only outage from a chat one.
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
      category: VIDEO_EVENT_CATEGORY,
    });

    expect(lastRow()!.category).toBe(VIDEO_EVENT_CATEGORY);
  });

  it("never throws, whatever the recorder does", async () => {
    // The caller is a health check on the request path. An observability write
    // that could fail one is worse than no write at all.
    mockRecordSystemErrorSafe.mockRejectedValueOnce(
      new Error("prisma exploded"),
    );

    await expect(
      recordStreamOutage({
        probe: "reachability",
        unhealthy: true,
        reason: "UNREACHABLE",
      }),
    ).resolves.toBeUndefined();
  });
});
