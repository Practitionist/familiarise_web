/**
 * @jest-environment node
 */

/**
 * #1615 — every recording start in this app is server-side, so
 * `call.recording_started` never carries a `user`. The handler used to write
 * `recordingStartedBy: user?.id || null` unconditionally, nulling the actor
 * the route had stamped one request earlier. This pins that a user-less event
 * touches neither `recordingStartedBy` nor an already-set `recordingStartedAt`.
 */

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
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

describe("handleRecordingStarted — actor and claim time", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("leaves recordingStartedBy and recordingStartedAt untouched for a user-less event", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: new Date("2026-09-12T22:06:00.000Z"),
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      created_at: "2026-09-12T22:06:28.522Z",
    });

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const { where, data } = mockUpdateMany.mock.calls[0][0];
    expect(where).toEqual({ id: "session-1", endedAt: null });
    expect(data).toEqual({
      isRecording: true,
      recordingStartedAt: new Date("2026-09-12T22:06:28.522Z"),
    });
    expect(data).not.toHaveProperty("recordingStartedBy");
  });

  it("keeps the route's actor even when the event names a user", async () => {
    const { handleRecordingStarted } =
      await import("../../lib/stream/recording-handlers");

    mockFindUnique.mockResolvedValue({
      id: "session-1",
      recordingStartedBy: "owner-user-id",
      recordingStartedAt: new Date("2026-09-12T22:06:00.000Z"),
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await handleRecordingStarted({
      call_cid: "default:call-1",
      type: "call.recording_started",
      created_at: "2026-09-12T22:06:28.522Z",
      user: { id: "someone-else" },
    });

    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({
      isRecording: true,
      recordingStartedAt: new Date("2026-09-12T22:06:28.522Z"),
    });
  });
});
