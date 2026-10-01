/**
 * @jest-environment node
 */

/**
 * The FAILURE BOUNDARY of `syncCallWindowForOccurrence`, not its payload logic
 * (`planner-call-window.test.ts` owns that).
 *
 * The helper's own header states the contract: the row is already committed, so
 * a failure here is logged, never thrown — because a throw could not undo the
 * save, it could only tell the planner their save failed when it succeeded. The
 * sole caller believes that literally. `crud-with-plan` awaits the helper AFTER
 * its Serializable transaction has committed (route.ts:993 commits, :1013
 * awaits) and its own catch returns a 500 "An error occurred while updating the
 * webinar" plus a Sentry event.
 *
 * The contract was broken by the code beneath it. The `try` opened at the
 * PROVIDER call and closed at its end, so everything above it ran outside the
 * boundary — including the very first thing the function does:
 *
 *   - `prisma.meeting.findUnique` — a pool exhaustion, a serialization failure
 *     or a reset connection rejects here. On a route that just committed a
 *     Serializable transaction against a saturated Supavisor, this is the most
 *     likely throw on the whole path, and it escaped.
 *   - `getStreamVideoClient()` — `validateStreamConfig` throws by design, and the
 *     line also constructs the singleton.
 *
 * Both were reachable from the caller's own `await` in the `try` that maps any
 * rejection to a 500. So the tests here are teeth, not decoration: each of the
 * first, second and fourth assertions below reverts to a rejection the moment the
 * boundary moves back down to the provider call.
 */

const mockMeetingFindUnique = jest.fn();
const mockCallGet = jest.fn();
const mockCallUpdate = jest.fn();
let mockStreamConfigured = true;
/** Set to make client acquisition throw, the way `validateStreamConfig` does. */
let mockClientAcquisition: Error | null = null;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => mockStreamConfigured,
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  getStreamVideoClient: () => {
    if (mockClientAcquisition) throw mockClientAcquisition;
    return {
      video: {
        call: (_type: string, id: string) => ({
          id,
          get: () => mockCallGet(),
          update: (payload: unknown) => mockCallUpdate(payload),
        }),
      },
    };
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { syncCallWindowForOccurrence } from "../../lib/meetings/sync-call-window";
import { streamLogger } from "../../lib/stream-logger";

/** What the committed planner save moved, as the caller hands it over. */
const OCCURRENCE = {
  id: "occ-1",
  startsAt: new Date("2026-09-13T10:00:00.000Z"),
  endsAt: new Date("2026-09-13T14:00:00.000Z"),
};

const STREAM_ERROR_MESSAGE =
  "Could not re-stamp the session window on the Stream call";

/** Every `streamLogger.error` call, as raw args. */
function errorCalls(): Array<[string, unknown, Record<string, unknown>?]> {
  return (streamLogger.error as unknown as jest.Mock).mock.calls as Array<
    [string, unknown, Record<string, unknown>?]
  >;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStreamConfigured = true;
  mockClientAcquisition = null;
  mockMeetingFindUnique.mockResolvedValue({
    id: "ms-1",
    streamCallId: "occurrence-occ-1",
  });
  mockCallGet.mockResolvedValue({
    call: { custom: { consultantUserId: "user-consultant" } },
  });
  mockCallUpdate.mockResolvedValue({});
});

describe("the boundary covers the Meeting lookup, not just the provider call", () => {
  it("logs and resolves when the DB lookup itself fails", async () => {
    // The regression. A transient pool exhaustion / serialization failure on this
    // read escaped the boundary, rejected into the route, and produced a 500 for
    // a planner save that had already committed. It must not reject now.
    const dbError = new Error(
      "Timed out fetching a new connection from the connection pool",
    );
    mockMeetingFindUnique.mockRejectedValue(dbError);

    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: false,
      reason: "stream_error",
    });

    // Logged rather than swallowed: the original error is handed to the logger so
    // `streamLogger.error`'s Sentry capture still fires for it.
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0][0]).toBe(STREAM_ERROR_MESSAGE);
    expect(errorCalls()[0][1]).toBe(dbError);
    // Nothing was written, so nothing may be claimed.
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });

  it("logs and resolves when acquiring the Stream client throws", async () => {
    // `getStreamVideoClient()` is a throwing call by contract — `validateStreamConfig`
    // raises on missing credentials, and the line constructs the singleton besides.
    // The preceding `isStreamConfigured()` gate closes off the missing-key case
    // specifically, so today this is reached by a constructor throw rather than the
    // config one; either way it is post-commit code and the boundary owns it.
    const acquisition = new Error(
      "NEXT_PUBLIC_STREAM_API_KEY is not configured. Please set it in your environment variables.",
    );
    mockClientAcquisition = acquisition;

    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: false,
      reason: "stream_error",
    });

    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0][1]).toBe(acquisition);
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });
});

describe("the happy path still re-stamps the call", () => {
  it("merges the moved window onto the call and reports the update", async () => {
    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: true,
    });

    expect(mockCallUpdate).toHaveBeenCalledTimes(1);
    expect(mockCallUpdate).toHaveBeenCalledWith({
      custom: {
        // Stream REPLACES `custom` wholesale, so the untouched keys must survive.
        consultantUserId: "user-consultant",
        sessionStartsAt: "2026-09-13T10:00:00.000Z",
        sessionEndsAt: "2026-09-13T14:00:00.000Z",
        sessionDurationMinutes: 240,
      },
      settings_override: {
        limits: { max_duration_seconds: (4 * 60 + 45) * 60 },
      },
    });
    expect(errorCalls()).toHaveLength(0);
  });
});

describe("the failure report names the meeting when it knows it", () => {
  it("logs the meeting and the stale call id when the provider call fails", async () => {
    const streamFailure = new Error("stream 500");
    mockCallGet.mockRejectedValue(streamFailure);

    await syncCallWindowForOccurrence(OCCURRENCE);

    expect(errorCalls()[0][1]).toBe(streamFailure);
    expect(errorCalls()[0][2]).toMatchObject({
      meetingId: "ms-1",
      streamCallId: "occurrence-occ-1",
    });
  });

  it("reports the same failure with no identity when the lookup never returned", async () => {
    // The `meeting?.id` guard. With the boundary opened above the lookup,
    // `meeting` is still null when the catch runs, and reading `.id` off it would
    // throw a `TypeError` out of the CATCH — a second failure stacked on the
    // first, and the 500 this whole boundary exists to prevent.
    mockMeetingFindUnique.mockRejectedValue(new Error("connection reset"));

    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: false,
      reason: "stream_error",
    });

    const context = errorCalls()[0][2];
    expect(Object.keys(context!).sort()).toEqual(["meetingId", "streamCallId"]);
    expect(context).toMatchObject({
      meetingId: undefined,
      streamCallId: undefined,
    });
  });
});
