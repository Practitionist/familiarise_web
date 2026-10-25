/** @jest-environment node */

const findJobs = jest.fn();
const updateJobs = jest.fn();
const deleteJobs = jest.fn();
const findEmails = jest.fn();
const deleteEmails = jest.fn();
const findBatches = jest.fn();
const deleteBatches = jest.fn();
const findNotifications = jest.fn();
const deleteNotifications = jest.fn();
const findEvents = jest.fn();
const deleteEvents = jest.fn();
const executeRaw = jest.fn();
const acquire = jest.fn();

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (key: string, opts: unknown, fn: () => Promise<unknown>) => {
    acquire(key, opts);
    return fn();
  },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {
      findMany: (...args: unknown[]) => findJobs(...args),
      updateMany: (...args: unknown[]) => updateJobs(...args),
      deleteMany: (...args: unknown[]) => deleteJobs(...args),
    },
    failedEmail: {
      findMany: (...args: unknown[]) => findEmails(...args),
      deleteMany: (...args: unknown[]) => deleteEmails(...args),
    },
    failedEmailBatch: {
      findMany: (...args: unknown[]) => findBatches(...args),
      deleteMany: (...args: unknown[]) => deleteBatches(...args),
    },
    notificationOutbox: {
      findMany: (...args: unknown[]) => findNotifications(...args),
      deleteMany: (...args: unknown[]) => deleteNotifications(...args),
    },
    emailEvent: {
      findMany: (...args: unknown[]) => findEvents(...args),
      deleteMany: (...args: unknown[]) => deleteEvents(...args),
    },
    $executeRaw: (...args: unknown[]) => executeRaw(...args),
    $disconnect: jest.fn(),
  },
}));

import { Prisma } from "@prisma/client";
import {
  retentionCutoff,
  sentOutboxRetentionCutoff,
  failedEmailBodyScrubCutoff,
  deadLetterOutboxRetentionCutoff,
  emailEventRetentionCutoff,
  strandedCutoff,
  STRANDED_ERROR,
  pruneMessagingRetentionTables,
  pruneSystemJobExecutions,
} from "../../scripts/cleanup/prune-system-job-executions";

const NOW = new Date("2026-10-23T03:26:00.000Z");
const DAY = 86_400_000;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  for (const find of [
    findJobs,
    findEmails,
    findBatches,
    findNotifications,
    findEvents,
  ]) {
    find.mockResolvedValue([]);
  }
  for (const mutate of [
    updateJobs,
    deleteJobs,
    deleteEmails,
    deleteBatches,
    deleteNotifications,
    deleteEvents,
  ]) {
    mutate.mockResolvedValue({ count: 0 });
  }
  executeRaw.mockResolvedValue(0);
});
afterEach(() => jest.useRealTimers());

it("preserves every existing retention window", () => {
  expect(retentionCutoff(NOW)).toEqual(new Date(NOW.getTime() - 90 * DAY));
  expect(sentOutboxRetentionCutoff(NOW)).toEqual(
    new Date(NOW.getTime() - 30 * DAY),
  );
  expect(failedEmailBodyScrubCutoff(NOW)).toEqual(
    new Date(NOW.getTime() - 7 * DAY),
  );
  expect(deadLetterOutboxRetentionCutoff(NOW)).toEqual(
    new Date(NOW.getTime() - 90 * DAY),
  );
  expect(emailEventRetentionCutoff(NOW)).toEqual(
    new Date(NOW.getTime() - 30 * DAY),
  );
  expect(strandedCutoff(NOW)).toEqual(
    new Date(NOW.getTime() - 6 * 60 * 60 * 1000),
  );
});

it("acquires a closed lease and caps every phase even when no HTTP limit is supplied", async () => {
  const result = await pruneSystemJobExecutions();
  expect(acquire).toHaveBeenCalledWith("prune-system-job-executions", {
    failMode: "closed",
  });
  for (const find of [
    findJobs,
    findEmails,
    findBatches,
    findNotifications,
    findEvents,
  ]) {
    for (const [args] of find.mock.calls) expect(args.take).toBe(101);
  }
  expect(result).toMatchObject({
    success: true,
    hasMore: false,
    pruned: 0,
    stranded: 0,
  });
});

it.each([0, -1, 1.5, 501, NaN, Infinity])(
  "rejects invalid core limit %s before locking or writing",
  async (limit) => {
    await expect(pruneSystemJobExecutions({ limit })).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    expect(findJobs).not.toHaveBeenCalled();
  },
);

it("mutates only a single page and reports additional rows without looping", async () => {
  findEvents.mockResolvedValue([
    { id: "event-1" },
    { id: "event-2" },
    { id: "event-3" },
  ]);
  deleteEvents.mockResolvedValue({ count: 2 });
  const result = await pruneMessagingRetentionTables(NOW, { limit: 2 });
  expect(result).toMatchObject({ emailEventsPruned: 2, hasMore: true });
  expect(findEvents).toHaveBeenCalledTimes(1);
  expect(deleteEvents).toHaveBeenCalledWith({
    where: {
      id: { in: ["event-1", "event-2"] },
      receivedAt: { lt: emailEventRetentionCutoff(NOW) },
    },
  });
});

it("rechecks a stranded execution's heartbeat and status in the write", async () => {
  findJobs.mockResolvedValueOnce([{ id: "stale" }, { id: "next" }]);
  updateJobs.mockResolvedValue({ count: 0 });
  const result = await pruneSystemJobExecutions({ limit: 1 });
  expect(updateJobs).toHaveBeenCalledWith({
    where: {
      id: { in: ["stale"] },
      status: "RUNNING",
      startedAt: { lt: strandedCutoff(NOW) },
    },
    data: { status: "FAILED", endedAt: NOW, errorLog: STRANDED_ERROR },
  });
  expect(result.stranded).toBe(0);
  expect(result.hasMore).toBe(true);
});

it("never selects or deletes RUNNING history rows for retention", async () => {
  findJobs.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "ended" }]);
  deleteJobs.mockResolvedValue({ count: 1 });
  const result = await pruneSystemJobExecutions();
  const where = {
    status: { not: "RUNNING" },
    startedAt: { lt: retentionCutoff(NOW) },
  };
  expect(findJobs).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ where }),
  );
  expect(deleteJobs).toHaveBeenCalledWith({
    where: { id: { in: ["ended"] }, ...where },
  });
  expect(result.pruned).toBe(1);
});

it.each([
  ["email", findEmails, deleteEmails],
  ["batch", findBatches, deleteBatches],
  ["notification", findNotifications, deleteNotifications],
])(
  "rechecks %s terminal status and age so a concurrent replay is preserved",
  async (_name, find, remove) => {
    if (find === findNotifications)
      find.mockResolvedValueOnce([{ id: "replayed" }]);
    else
      find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "replayed" }]);
    remove.mockResolvedValue({ count: 0 });
    const result = await pruneMessagingRetentionTables(NOW);
    const selection = find.mock.calls[find === findNotifications ? 0 : 1][0];
    expect(remove).toHaveBeenCalledWith({
      where: { AND: [selection.where, { id: { in: ["replayed"] } }] },
    });
    expect(selection.where.OR).toEqual(
      expect.arrayContaining([
        {
          status: "DEAD_LETTER",
          updatedAt: { lt: deadLetterOutboxRetentionCutoff(NOW) },
        },
      ]),
    );
    expect(
      selection.where.OR.every((branch: { status: string }) =>
        ["SENT", "DEAD_LETTER"].includes(branch.status),
      ),
    ).toBe(true);
    expect(
      result.failedEmailsPruned +
        result.failedEmailBatchesPruned +
        result.notificationOutboxPruned,
    ).toBe(0);
  },
);

it("scrubs sent payloads with bound parameters and preserves both retention timestamps", async () => {
  findEmails.mockResolvedValueOnce([{ id: "mail'bound" }]);
  findBatches.mockResolvedValueOnce([{ id: "batch-bound" }]);
  executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
  const result = await pruneMessagingRetentionTables(NOW);
  const queries: Prisma.Sql[] = executeRaw.mock.calls.map(([query]) => query);
  expect(queries).toHaveLength(2);
  for (const query of queries) {
    expect(query.sql).toContain("\"status\" = 'SENT'");
    expect(query.sql).toContain('COALESCE("sentAt", "updatedAt") < ?');
    expect(query.sql).not.toContain('SET "updatedAt"');
    expect(query.values).toContainEqual(failedEmailBodyScrubCutoff(NOW));
  }
  expect(queries[0].values).toContain("mail'bound");
  expect(queries[0].sql).not.toContain("mail'bound");
  expect(queries[1].sql).toContain("SET \"payload\" = '[]'::jsonb");
  expect(result).toMatchObject({
    failedEmailsBodyScrubbed: 1,
    failedEmailBatchesScrubbed: 1,
  });
});

it("does not swallow a database error or continue to later destructive phases", async () => {
  findJobs.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(pruneSystemJobExecutions()).rejects.toThrow(
    "database unavailable",
  );
  expect(findEmails).not.toHaveBeenCalled();
  expect(deleteJobs).not.toHaveBeenCalled();
});

it("stops admitting reads and writes when the shared start budget expires", async () => {
  findJobs.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return [{ id: "selected-before-deadline" }];
  });
  const result = await pruneSystemJobExecutions();
  expect(result).toMatchObject({ hasMore: true, stranded: 0, pruned: 0 });
  expect(findJobs).toHaveBeenCalledTimes(1);
  expect(updateJobs).not.toHaveBeenCalled();
  expect(findEmails).not.toHaveBeenCalled();
});

it("resumes from remaining rows after a partially committed run crashes", async () => {
  findJobs
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: "history-1" }]);
  deleteJobs.mockResolvedValueOnce({ count: 1 });
  findEmails.mockRejectedValueOnce(
    new Error("connection lost after history deletion"),
  );
  await expect(pruneSystemJobExecutions()).rejects.toThrow("connection lost");
  findEmails
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: "email-remaining" }]);
  deleteEmails.mockResolvedValueOnce({ count: 1 });
  const retry = await pruneSystemJobExecutions();
  expect(retry).toMatchObject({
    pruned: 0,
    failedEmailsPruned: 1,
    success: true,
  });
  expect(deleteJobs).toHaveBeenCalledTimes(1);
});
