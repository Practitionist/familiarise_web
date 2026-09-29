/**
 * @jest-environment node
 */

/**
 * #1615 — every recording start in this app is server-side, so
 * `call.recording_started` never carries a `user`. The handler used to write
 * `recordingStartedBy: user?.id || null` unconditionally, nulling the actor
 * the route had stamped one request earlier. This pins that a user-less event
 * touches neither `recordingStartedBy` nor an already-set `recordingStartedAt`.
 *
 * #C4 — and the write is a compare-and-set `updateMany` rather than a bare
 * `update`. A replayed or late `recording_started` must not resurrect
 * `isRecording` after a `recording_stopped` has cleared it, so the guard is the
 * event's own clock against the claim time we already hold. Note that a plain
 * CAS on `isRecording: false` would NOT do it: the post-stop row satisfies that
 * predicate, which is precisely the state being protected.
 */

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
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

const CLAIMED_AT = new Date("2026-09-12T22:06:00.000Z");

describe("handleRecordingStarted — actor and claim time", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("leaves recordingStartedBy and recordingStartedAt untouched for a user-less event", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: CLAIMED_AT,
    });
    mockUpdate.mockResolvedValue({});

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      created_at: "2026-09-12T22:06:28.522Z",
    });

    // #C4 — `updateMany`, and never `update`: a status change goes through the
    // value it read. The bare `update` is asserted unused so a future "simplify"
    // cannot put the unconditional write back without failing here.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const { data, where } = mockUpdateMany.mock.calls[0][0];
    expect(data).toEqual({ isRecording: true });
    expect(data).not.toHaveProperty("recordingStartedBy");
    expect(data).not.toHaveProperty("recordingStartedAt");
    // The claim is at 22:06:00 and the event is at 22:06:28 — newer, so it is
    // admitted, and `isRecording` is set. The predicate is on the claim time, not
    // on `isRecording`.
    expect(where).toEqual({
      id: "session-1",
      OR: [
        { recordingStartedAt: null },
        { recordingStartedAt: { lt: new Date("2026-09-12T22:06:28.522Z") } },
      ],
    });
  });

  it("keeps the route's actor even when the event names a user", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: CLAIMED_AT,
    });
    mockUpdate.mockResolvedValue({});

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      created_at: "2026-09-12T22:06:28.522Z",
      user: { id: "someone-else" },
    });

    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ isRecording: true });
  });
});

/**
 * The resurrection, stated as a test. The row says the recording stopped at
 * 22:10; Stream re-delivers the `recording_started` from 22:06 (it retries for
 * 168 h and does not promise ordering). The predicate matches nothing, so the
 * write does not happen and the row keeps saying "not recording".
 */
describe("handleRecordingStarted — a replayed start cannot resurrect a stopped recording", () => {
  beforeEach(() => jest.clearAllMocks());

  it("matches nothing when the event predates the claim we already hold", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      // The route claimed this recording, then the stop cleared the flag.
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: CLAIMED_AT,
      isRecording: false,
    });
    // The guard does its job: the row's claim (22:06:00) is NOT older than the
    // event (22:06:28 came first in the replay, so use an older event time).
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      // Earlier than the claim: this is the replay.
      created_at: "2026-09-12T22:05:59.000Z",
    });

    const { where } = mockUpdateMany.mock.calls[0][0];
    // Both branches are refused for a row that already holds a newer claim:
    // `null` is false (there is a claim) and `claim < event` is false (22:06:00
    // is not before 22:05:59). A count of 0 is the whole mechanism, and the
    // handler must not treat it as an error.
    expect(where.OR).toEqual([
      { recordingStartedAt: null },
      { recordingStartedAt: { lt: new Date("2026-09-12T22:05:59.000Z") } },
    ]);
  });

  it("adopts a genuine RESTART, whose event is newer than the previous claim", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: CLAIMED_AT,
      isRecording: false,
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      created_at: "2026-09-12T23:40:00.000Z",
    });

    // 22:06:00 < 23:40:00, so the second branch of the predicate matches and a
    // real second recording is still recorded as recording. The flag is NOT
    // latched forever by this fix.
    expect(mockUpdateMany.mock.calls[0][0].where.OR).toContainEqual({
      recordingStartedAt: { lt: new Date("2026-09-12T23:40:00.000Z") },
    });
    // #1615 still holds: a restart does not re-claim the time or the actor.
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ isRecording: true });
  });
});
