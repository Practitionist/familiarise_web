/**
 * @jest-environment node
 */

import {
  withCronLock,
  CronLockHeldError,
  CronLockUnavailableError,
  LONG_JOB_TTL_MS,
  effectiveLeaseTtlMs,
  isPrismaConnectionOrPoolError,
} from "../../lib/cron/with-cron-lock";
import prisma from "../../lib/prisma";
import redis from "../../lib/redis";
import { currentRun, withRunContext } from "../../lib/cron/run-context";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    set: jest.fn().mockResolvedValue("OK"),
  },
}));

const delegate = (
  prisma as unknown as {
    systemJobExecution: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  }
).systemJobExecution;

const mockRedisSet = (redis as unknown as { set: jest.Mock }).set;

// Either host marker caps the lease, so every test starts off Netlify.
const priorHost = {
  NETLIFY: process.env.NETLIFY,
  SITE_ID: process.env.SITE_ID,
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
};
afterAll(() => {
  for (const [key, value] of Object.entries(priorHost)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  delete process.env.NETLIFY;
  delete process.env.SITE_ID;
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
  jest.clearAllMocks();
  delegate.findFirst.mockResolvedValue(null);
  delegate.create.mockResolvedValue({ id: "exec-1" });
  delegate.update.mockResolvedValue({});
  delegate.updateMany.mockResolvedValue({ count: 1 });
  mockRedisSet.mockResolvedValue("OK");
});

describe("withCronLock (Postgres lease on SystemJobExecution)", () => {
  it("acquires a RUNNING row, runs the callback, marks COMPLETED, and touches cron:heartbeat:last", async () => {
    const fn = jest.fn().mockResolvedValue("done");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).resolves.toBe("done");

    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { jobName: "dunning", status: "RUNNING" },
      select: { id: true, startedAt: true, createdAt: true, result: true },
    });
    expect(delegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        jobId: "dunning",
        jobName: "dunning",
        status: "RUNNING",
        triggeredBy: expect.stringMatching(/^(cron|github-actions)$/),
        result: { environment: "production" },
      }),
      select: { id: true },
    });
    expect(delegate.updateMany).toHaveBeenCalledTimes(1);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: "exec-1", status: "RUNNING" },
      data: expect.objectContaining({
        status: "COMPLETED",
        result: expect.objectContaining({ outcome: "completed" }),
        endedAt: expect.any(Date),
        durationMs: expect.any(Number),
      }),
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      "cron:heartbeat:last",
      expect.any(String),
    );
  });

  it("throws CronLockHeldError (409) carrying the holder when a live RUNNING row exists", async () => {
    delegate.findFirst.mockResolvedValue({
      id: "exec-live",
      startedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    });
    const fn = jest.fn();

    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockHeldError);
    expect((err as CronLockHeldError).httpStatus).toBe(409);
    expect((err as CronLockHeldError).holderRunId).toBe("exec-live");
    expect(fn).not.toHaveBeenCalled();
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it("converts a P2002 unique-index race on create into CronLockHeldError (409)", async () => {
    delegate.create.mockRejectedValue(
      Object.assign(
        new Error(
          "Unique constraint failed on the fields: (`SystemJobExecution_running_jobName_key`)",
        ),
        { code: "P2002" },
      ),
    );
    const fn = jest.fn();

    const err = await withCronLock(
      "cleanup-auth-tokens",
      { failMode: "open" },
      fn,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CronLockHeldError);
    expect((err as CronLockHeldError).httpStatus).toBe(409);
    expect(fn).not.toHaveBeenCalled();
  });

  it("judges a long job's heartbeat against the capped lease: inside it holds, past it is swept", async () => {
    const heartbeat = (ageMs: number) => ({
      id: "exec-old",
      startedAt: new Date(Date.now() - ageMs),
      createdAt: new Date(Date.now() - ageMs - 60_000),
      result: { environment: "preview" },
    });
    delegate.findFirst.mockResolvedValueOnce(heartbeat(90_000 - 5_000));
    await expect(
      withCronLock(
        "create-payout-batch",
        { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
        async () => null,
      ),
    ).rejects.toBeInstanceOf(CronLockHeldError);

    delegate.findFirst.mockResolvedValueOnce(heartbeat(90_000 + 5_000));
    await withRunContext({ triggeredBy: "cron" }, async () => {
      await withCronLock(
        "create-payout-batch",
        { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
        async () => null,
      );
      expect(currentRun()?.counters.leaseTakeover).toBe(1);
    });
    const sweep = delegate.updateMany.mock.calls[0][0];
    const takenOverBy = delegate.create.mock.calls[0][0].data.id;
    expect(sweep).toEqual({
      where: {
        id: "exec-old",
        status: "RUNNING",
        startedAt: { lte: expect.any(Date) },
      },
      data: {
        status: "FAILED",
        endedAt: expect.any(Date),
        durationMs: expect.any(Number),
        errorLog: "Lease expired (stale RUNNING row swept)",
        result: {
          outcome: "failed",
          reason: "lease-expired",
          environment: "preview",
          takenOverBy,
        },
      },
    });
    // Duration runs from the swept row's acquisition, not its last heartbeat.
    expect(sweep.data.durationMs).toBeGreaterThanOrEqual(90_000 + 65_000);
  });

  it("caps the lease to 90 s on every host so takers agree on staleness", () => {
    expect(effectiveLeaseTtlMs(LONG_JOB_TTL_MS)).toBe(90_000);
    expect(effectiveLeaseTtlMs(30_000)).toBe(30_000);
    process.env.NETLIFY = "true";
    expect(effectiveLeaseTtlMs(LONG_JOB_TTL_MS)).toBe(90_000);
    delete process.env.NETLIFY;
  });

  it("re-arms the lease every third of the TTL while the job runs and computes durationMs from initial acquisition", async () => {
    jest.useFakeTimers();
    try {
      let finish: () => void = () => {};
      const running = withCronLock(
        "reconcile",
        { failMode: "closed", ttlMs: 30 * 60 * 1000 },
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      await jest.advanceTimersByTimeAsync(30_000 + 1);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { id: "exec-1", status: "RUNNING" },
        data: { startedAt: expect.any(Date) },
      });
      await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
      finish();
      await running;
      const renewals = delegate.updateMany.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(delegate.updateMany).toHaveBeenCalledTimes(renewals);

      // Duration runs from acquisition (~15 min), not from the last 30 s renewal.
      const finishArgs = delegate.updateMany.mock.calls.find(
        ([args]) => args.data.endedAt && args.where.id,
      )[0];
      expect(finishArgs.data.durationMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
    } finally {
      jest.useRealTimers();
    }
  });

  it("marks the row FAILED with truncated errorLog when the job throws", async () => {
    const huge = new Error("x".repeat(50_000));
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => {
        throw huge;
      }),
    ).rejects.toBe(huge);

    const finish = delegate.updateMany.mock.calls.find(
      ([args]) => args.data.endedAt && args.where.id,
    )[0];
    expect(finish.where).toEqual({ id: "exec-1", status: "RUNNING" });
    expect(finish.data.status).toBe("FAILED");
    expect(finish.data.errorLog).toHaveLength(8_000);
  });

  it("fail-closed: throws CronLockUnavailableError when database lock acquisition fails", async () => {
    delegate.findFirst.mockRejectedValue(new Error("db down"));
    const fn = jest.fn();
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-open: still fails closed when the database connection pool is exhausted (P2024)", async () => {
    delegate.findFirst.mockRejectedValue(
      Object.assign(
        new Error(
          "Timed out fetching a new connection from the connection pool",
        ),
        { code: "P2024" },
      ),
    );
    const fn = jest.fn();
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-open: runs unlocked with a warning when a non-connection database error occurs", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    delegate.create.mockRejectedValue(new Error("unexpected schema error"));
    const fn = jest.fn().mockResolvedValue("still ran");

    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).resolves.toBe("still ran");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delegate.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("records the run in the active context and takes triggeredBy from it", async () => {
    await withRunContext({ triggeredBy: "admin:user-1" }, async () => {
      await withCronLock("dunning", { failMode: "closed" }, async () => ({
        checkpoint: "cursor-9",
      }));
      const run = currentRun();
      expect(run?.runIds).toEqual(["exec-1"]);
      expect(run?.finished.get("exec-1")).toEqual({ checkpoint: "cursor-9" });
    });
    expect(delegate.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ triggeredBy: "admin:user-1" }),
      }),
    );
  });

  it("stamps triggeredBy as github-actions when GITHUB_ACTIONS is set, otherwise cron", async () => {
    const prev = process.env.GITHUB_ACTIONS;
    try {
      delete process.env.GITHUB_ACTIONS;
      await withCronLock("dunning", { failMode: "closed" }, async () => "ok");
      expect(delegate.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ triggeredBy: "cron" }),
        }),
      );

      process.env.GITHUB_ACTIONS = "true";
      await withCronLock("dunning", { failMode: "closed" }, async () => "ok");
      expect(delegate.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ triggeredBy: "github-actions" }),
        }),
      );
    } finally {
      if (prev === undefined) {
        delete process.env.GITHUB_ACTIONS;
      } else {
        process.env.GITHUB_ACTIONS = prev;
      }
    }
  });
});

describe("execution outcomes", () => {
  it.each([
    {
      result: { failed: 2, remaining: 0 },
      outcome: "partial",
      status: "FAILED",
    },
    { result: { success: false }, outcome: "failed", status: "FAILED" },
    { result: { skipped: true }, outcome: "skipped", status: "CANCELLED" },
  ])(
    "records $outcome without advancing success freshness",
    async ({ result, outcome, status }) => {
      await withCronLock("job", { failMode: "closed" }, async () => result);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { id: "exec-1", status: "RUNNING" },
        data: expect.objectContaining({
          status,
          result: expect.objectContaining({ outcome }),
        }),
      });
      expect(mockRedisSet).not.toHaveBeenCalled();
    },
  );

  it("cannot finish or refresh freshness after another runner expired the lease", async () => {
    delegate.updateMany.mockResolvedValue({ count: 0 });
    await withCronLock("job", { failMode: "closed" }, async () => ({
      success: true,
    }));
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(delegate.update).not.toHaveBeenCalled();
  });

  it("does not invoke a closed job when importing the lock delegate fails", async () => {
    jest.resetModules();
    jest.doMock("../../lib/prisma", () => {
      throw new Error("Prisma unavailable");
    });
    const isolated = await import("../../lib/cron/with-cron-lock");
    const fn = jest.fn();
    await expect(
      isolated.withCronLock("money", { failMode: "closed" }, fn),
    ).rejects.toMatchObject({ code: "CRON_LOCK_UNAVAILABLE" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("isPrismaConnectionOrPoolError", () => {
  it("matches Prisma-raised pool and connection faults only", () => {
    expect(isPrismaConnectionOrPoolError({ code: "P2024", message: "x" })).toBe(
      true,
    );
    const txTimeout = Object.assign(
      new Error("Unable to start a transaction in the given time."),
      { name: "PrismaClientKnownRequestError" },
    );
    expect(isPrismaConnectionOrPoolError(txTimeout)).toBe(true);
    expect(
      isPrismaConnectionOrPoolError(new Error("timeout of 3000ms exceeded")),
    ).toBe(false);
    expect(
      isPrismaConnectionOrPoolError(
        Object.assign(new Error("Unique constraint failed"), {
          name: "PrismaClientKnownRequestError",
          code: "P2002",
        }),
      ),
    ).toBe(false);
  });
});
