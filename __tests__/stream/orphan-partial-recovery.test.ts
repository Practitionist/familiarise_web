/** @jest-environment node */
const mockFindMany = jest.fn();
const mockSync = jest.fn();
const mockCheckpoint = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: jest.fn().mockResolvedValue(0),
    },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, run: () => unknown) => run(),
  readJobCheckpoint: () => mockCheckpoint(),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
}));
jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: {
    syncSessionRecordings: (...args: unknown[]) => mockSync(...args),
  },
}));
import { reconcileOrphanedRecordings } from "../../scripts/stream/reconcile-orphaned-recordings";
const session = (id: string, partial = false) => ({
  id,
  streamCallId: `call-${id}`,
  occurrence: { appointment: null },
  recordings: partial ? [{ id: "existing" }] : [],
});
beforeEach(() => {
  jest.clearAllMocks();
  mockCheckpoint.mockResolvedValue(null);
  mockFindMany.mockResolvedValue([]);
  mockSync.mockResolvedValue({ ok: true });
});
afterEach(() => jest.restoreAllMocks());

it("takes a snapshot containing both zero-row and partially delivered sessions before recovery", async () => {
  mockFindMany.mockResolvedValue([session("a"), session("b", true)]);
  mockSync.mockImplementation(async (_session, recovered) => {
    recovered.push({ id: "new-segment" });
    return { ok: true };
  });
  const result = await reconcileOrphanedRecordings();
  expect(result).toMatchObject({
    success: true,
    scanned: 1,
    recovered: 1,
    partialScanned: 1,
    partialRecovered: 1,
    checkpoint: "b",
  });
  expect(mockFindMany).toHaveBeenCalledTimes(1);
  expect(mockFindMany.mock.calls[0][0]).toMatchObject({
    take: 25,
    orderBy: { id: "asc" },
    include: { recordings: { take: 1 } },
  });
  expect(mockFindMany.mock.calls[0][0].where.recordings).toBeUndefined();
  expect(mockSync.mock.calls.every((call) => call[2].notify === true)).toBe(
    true,
  );
});

it("reaches the partial-delivery tail despite a persistent empty-source prefix", async () => {
  const rows = Array.from({ length: 26 }, (_, i) =>
    session(String(i).padStart(3, "0"), i === 25),
  );
  mockFindMany.mockImplementation(async ({ where, take }) =>
    rows.filter((r) => !where.id || r.id > where.id.gt).slice(0, take),
  );
  const first = await reconcileOrphanedRecordings();
  mockCheckpoint.mockResolvedValue(first.checkpoint);
  const second = await reconcileOrphanedRecordings();
  expect(first).toMatchObject({
    scanned: 25,
    stillMissing: 25,
    hasMore: true,
    checkpoint: "024",
  });
  expect(second).toMatchObject({ partialScanned: 1, checkpoint: "025" });
  expect(mockSync).toHaveBeenCalledTimes(26);
});

it("wraps using an ID bound even if the saved cursor row was deleted", async () => {
  mockCheckpoint.mockResolvedValue("deleted-tail");
  mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([session("a")]);
  expect(await reconcileOrphanedRecordings()).toMatchObject({
    checkpoint: "a",
    scanned: 1,
  });
  expect(mockFindMany.mock.calls[0][0].where.id).toEqual({
    gt: "deleted-tail",
  });
  expect(mockFindMany.mock.calls[1][0].where.id).toBeUndefined();
});

it("treats swallowed provider failure as failure and still examines the next session", async () => {
  mockFindMany.mockResolvedValue([session("a"), session("b", true)]);
  mockSync.mockResolvedValueOnce({ ok: false, reason: "stream-unreachable" });
  const result = await reconcileOrphanedRecordings();
  expect(result).toMatchObject({
    success: false,
    stillMissing: 0,
    partialScanned: 1,
    checkpoint: "b",
  });
  expect(result.errors).toEqual([
    expect.stringContaining("stream-unreachable"),
  ]);
});

it("stops starting work at its time budget and leaves unstarted rows before the next cursor", async () => {
  let now = Date.now();
  jest.spyOn(Date, "now").mockImplementation(() => now);
  mockFindMany.mockResolvedValue([session("a"), session("b")]);
  mockSync.mockImplementation(async () => {
    now += 6 * 60_000;
    return { ok: true };
  });
  expect(await reconcileOrphanedRecordings()).toMatchObject({
    scanned: 1,
    checkpoint: "a",
    hasMore: true,
  });
  expect(mockSync).toHaveBeenCalledTimes(1);
});
