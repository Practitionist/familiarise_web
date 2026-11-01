/** @jest-environment node */
const findConsent = jest.fn(),
  deleteConsent = jest.fn(),
  findEvents = jest.fn(),
  deleteEvents = jest.fn();
const lock = jest.fn(
  (_name: string, _opts: unknown, run: () => Promise<unknown>) => run(),
);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: {
      findMany: (...a: unknown[]) => findConsent(...a),
      deleteMany: (...a: unknown[]) => deleteConsent(...a),
    },
    $queryRaw: (...a: unknown[]) => findEvents(...a),
    $executeRaw: (...a: unknown[]) => deleteEvents(...a),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (name: string, opts: unknown, run: () => Promise<unknown>) =>
    lock(name, opts, run),
}));
import { runConsentRetentionSweeper } from "../../lib/compliance/consent-retention";
import { pruneSystemEvents } from "../../lib/observability/system-event-retention";
beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());
it("only counts expired consents by default", async () => {
  findConsent.mockResolvedValue([{ id: "expired" }]);
  expect(await runConsentRetentionSweeper()).toMatchObject({
    deleteMode: false,
    deleted: 0,
  });
  expect(deleteConsent).not.toHaveBeenCalled();
  expect(lock).toHaveBeenCalledWith(
    "consent-retention-sweeper",
    { failMode: "closed" },
    expect.any(Function),
  );
});
it("drains25 expired consents in three bounded slices while preserving a concurrent extension", async () => {
  let rows = Array.from({ length: 25 }, (_, i) => ({
    id: String(i),
    deadline: new Date(0),
  }));
  findConsent.mockImplementation(async (q: { take: number }) =>
    rows
      .filter((r) => r.deadline < new Date())
      .slice(0, q.take)
      .map(({ id }) => ({ id })),
  );
  let extended = false;
  deleteConsent.mockImplementation(
    async (q: {
      where: { id: { in: string[] }; auditRetainedUntil?: { lt: Date } };
    }) => {
      if (!extended) {
        rows[0].deadline = new Date("2099-01-01");
        extended = true;
      }
      const before = rows.length;
      rows = rows.filter(
        (r) =>
          !q.where.id.in.includes(r.id) ||
          (q.where.auditRetainedUntil !== undefined &&
            r.deadline >= q.where.auditRetainedUntil.lt),
      );
      return { count: before - rows.length };
    },
  );
  const results = [];
  for (let i = 0; i < 3; i++)
    results.push(await runConsentRetentionSweeper({ limit: 10, delete: true }));
  expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(24);
  expect(rows).toEqual([{ id: "0", deadline: new Date("2099-01-01") }]);
  expect(results[0].hasMore).toBe(true);
  expect(results[2].hasMore).toBe(false);
});
it("caps event history and rechecks the existing400day cutoff in the mutation", async () => {
  let ids = Array.from({ length: 25 }, (_, i) => String(i));
  findEvents.mockImplementation(async (q: { values: unknown[] }) =>
    ids.slice(0, Number(q.values.at(-1))).map((id) => ({ id })),
  );
  deleteEvents.mockImplementation(async (q: { values: unknown[] }) => {
    const cutoff = q.values.find((v): v is Date => v instanceof Date);
    expect(cutoff?.getTime()).toBeLessThan(Date.now() - 399 * 86400000);
    const n = ids.length;
    ids = ids.filter((id) => !q.values.includes(id));
    return n - ids.length;
  });
  let total = 0;
  for (let i = 0; i < 3; i++)
    total += (await pruneSystemEvents({ limit: 10 })).pruned;
  expect(total).toBe(25);
  expect(ids).toEqual([]);
  expect(findEvents.mock.calls[0][0].values.at(-1)).toBe(11);
});

it("does not start either retention selection after the caller deadline", async () => {
  const startedAt = Date.now() - 16_000;
  const consent = await runConsentRetentionSweeper({ startedAt });
  const events = await pruneSystemEvents({ startedAt });

  expect(consent).toMatchObject({ hasMore: true, deleted: 0 });
  expect(events).toMatchObject({ hasMore: true, pruned: 0 });
  expect(findConsent).not.toHaveBeenCalled();
  expect(deleteConsent).not.toHaveBeenCalled();
  expect(findEvents).not.toHaveBeenCalled();
  expect(deleteEvents).not.toHaveBeenCalled();
});

it("does not delete a selected consent or event page after selection uses the budget", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-23T01:00:00Z"));
  findConsent.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return [{ id: "expired-consent" }];
  });
  findEvents.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
    return [{ id: "expired-event" }];
  });
  const consent = await runConsentRetentionSweeper({
    limit: 10,
    startedAt: Date.now(),
    delete: true,
  });
  jest.setSystemTime(new Date("2026-10-23T01:00:00Z"));
  const events = await pruneSystemEvents({ limit: 10, startedAt: Date.now() });

  expect(consent).toMatchObject({ hasMore: true, deleted: 0 });
  expect(events).toMatchObject({ hasMore: true, pruned: 0 });
  expect(deleteConsent).not.toHaveBeenCalled();
  expect(deleteEvents).not.toHaveBeenCalled();
});
