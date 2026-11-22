/** @jest-environment node */
const mockMeetingFindMany = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockPresenceUpdateMany = jest.fn();
const mockCallGet = jest.fn();
const mockTransaction = jest.fn();
let mockCheckpoint: string | null = null;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...a: unknown[]) => mockMeetingFindMany(...a),
      updateMany: () => {
        throw new Error("Global Prisma write inside transaction");
      },
    },
    meetingPresence: {
      updateMany: () => {
        throw new Error("Global Prisma write inside transaction");
      },
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: async (
    _name: string,
    _options: unknown,
    run: () => Promise<{ checkpoint: string | null }>,
  ) => {
    const result = await run();
    mockCheckpoint = result.checkpoint;
    return result;
  },
  readJobCheckpoint: async () => mockCheckpoint,
}));
jest.mock("../../lib/observability/run-failures", () => ({
  createRunFailureReporter: () => ({ add: jest.fn(), flush: jest.fn() }),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  isExpectedStreamError: (error: unknown) =>
    error instanceof Error && error.message === "confirmed missing call",
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: () => ({
    video: { call: () => ({ get: (...a: unknown[]) => mockCallGet(...a) }) },
  }),
}));
import {
  BATCH_SIZE,
  reconcileOrphanedSessions,
} from "../../lib/meetings/reconcile-orphaned-sessions";

const endedAt = new Date("2026-10-01T11:02:00Z");
const meeting = (id: string) => ({
  id,
  streamCallId: `call-${id}`,
  extendedSeconds: 0,
  occurrence: { endsAt: new Date("2026-10-01T11:00:00Z") },
});
beforeEach(() => {
  jest.clearAllMocks();
  mockCheckpoint = null;
  mockMeetingFindMany.mockReset();
  mockCallGet.mockResolvedValue({ call: { ended_at: endedAt.toISOString() } });
  mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
  mockPresenceUpdateMany.mockResolvedValue({ count: 2 });
  mockTransaction.mockImplementation((run) =>
    run({
      meeting: { updateMany: mockMeetingUpdateMany },
      meetingPresence: { updateMany: mockPresenceUpdateMany },
    }),
  );
});
afterEach(() => {
  jest.useRealTimers();
});

it("atomically closes the meeting and its segment presences through the transaction client", async () => {
  mockMeetingFindMany.mockResolvedValueOnce([meeting("a")]);
  const result = await reconcileOrphanedSessions();
  expect(mockTransaction).toHaveBeenCalledTimes(1);
  expect(mockMeetingFindMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: BATCH_SIZE, orderBy: { id: "asc" } }),
  );
  expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
    where: { id: "a", streamCallId: "call-a", endedAt: null },
    data: { endedAt, endedReason: "reconciled" },
  });
  expect(mockPresenceUpdateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        meetingId: "a",
        OR: [{ streamCallId: "call-a" }, { streamCallId: null }],
      }),
      data: { leftAt: endedAt, closedByEnd: true },
    }),
  );
  expect(result).toMatchObject({
    reconciled: 1,
    checkpoint: null,
    hasMore: false,
  });
});

it("persists rotation past an unchanged active head and reaches the tail on the next invocation", async () => {
  const head = Array.from({ length: BATCH_SIZE }, (_, i) => meeting(`a${i}`));
  mockMeetingFindMany
    .mockResolvedValueOnce(head)
    .mockResolvedValueOnce([meeting("tail")]);
  mockCallGet.mockImplementation(async () =>
    mockCallGet.mock.calls.length <= BATCH_SIZE
      ? {
          call: {
            ended_at: null,
            session: { participants: [{ user_id: "host" }] },
          },
        }
      : { call: { ended_at: endedAt.toISOString() } },
  );
  const first = await reconcileOrphanedSessions();
  const second = await reconcileOrphanedSessions();
  expect(first).toMatchObject({
    checkpoint: head.at(-1)?.id,
    hasMore: true,
    reconciled: 0,
  });
  expect(mockMeetingFindMany).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      where: expect.objectContaining({ id: { gt: head.at(-1)?.id } }),
      take: BATCH_SIZE,
    }),
  );
  expect(second).toMatchObject({ reconciled: 1, checkpoint: null });
});

it("wraps even if the checkpoint row was deleted and advances past a failed provider read", async () => {
  mockCheckpoint = "removed-row";
  mockMeetingFindMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(
      Array.from({ length: BATCH_SIZE }, (_, i) => meeting(`a${i}`)),
    );
  mockCallGet.mockRejectedValueOnce(new Error("provider unavailable"));
  const result = await reconcileOrphanedSessions();
  expect(mockMeetingFindMany).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      where: {
        endedAt: null,
        occurrence: { endsAt: { lt: expect.any(Date) } },
      },
    }),
  );
  expect(result).toMatchObject({ success: false, errors: 1, checkpoint: "a4" });
});

it("stops admitting reads after its short start budget without checkpointing an unstarted row", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-25T00:00:00Z"));
  mockMeetingFindMany.mockResolvedValueOnce([meeting("a"), meeting("b")]);
  mockCallGet.mockImplementationOnce(async () => {
    jest.setSystemTime(new Date(Date.now() + 7_000));
    return { call: { ended_at: endedAt.toISOString() } };
  });
  const result = await reconcileOrphanedSessions();
  expect(mockCallGet).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    processed: 1,
    checkpoint: "a",
    hasMore: true,
  });
});

it("skips an extended live room and never closes presences after losing the meeting CAS", async () => {
  mockMeetingFindMany.mockResolvedValueOnce([
    {
      ...meeting("extended"),
      occurrence: { endsAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      extendedSeconds: 2 * 60 * 60,
    },
    meeting("lost"),
  ]);
  mockMeetingUpdateMany.mockResolvedValueOnce({ count: 0 });
  const result = await reconcileOrphanedSessions();
  expect(result.processed).toBe(1);
  expect(mockCallGet).toHaveBeenCalledTimes(1);
  expect(mockPresenceUpdateMany).not.toHaveBeenCalled();
});
