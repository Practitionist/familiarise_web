/**
 * @jest-environment node
 */

import {
  withCronLock,
  CronLockHeldError,
  CronLockUnavailableError,
  LONG_JOB_TTL_MS,
} from "../../lib/cron/with-cron-lock";
import prisma from "../../lib/prisma";
import redis from "../../lib/redis";

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

beforeEach(() => {
  jest.clearAllMocks();
  delegate.findFirst.mockResolvedValue(null);
  delegate.create.mockResolvedValue({ id: "exec-1" });
  delegate.update.mockResolvedValue({});
  delegate.updateMany.mockResolvedValue({ count: 1 });
  mockRedisSet.mockResolvedValue("OK");
});

describe("withCronLock (Postgres lease on SystemJobExecution)", () => {
  it("sweeps expired RUNNING rows, acquires a RUNNING row, runs the callback, marks COMPLETED, and touches cron:heartbeat:last", async () => {
    const fn = jest.fn().mockResolvedValue("done");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).resolves.toBe("done");

    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: {
        jobName: "dunning",
        status: "RUNNING",
        startedAt: { lte: expect.any(Date) },
      },
      data: {
        status: "FAILED",
        endedAt: expect.any(Date),
        errorLog: "Lease expired (stale RUNNING row swept)",
      },
    });

    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    const findArgs = delegate.findFirst.mock.calls[0][0];
    expect(findArgs.where.jobName).toBe("dunning");
    expect(findArgs.where.status).toBe("RUNNING");
    expect(findArgs.where.startedAt.gt).toBeInstanceOf(Date);

    expect(delegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: "dunning",
        jobName: "dunning",
        status: "RUNNING",
        triggeredBy: expect.stringMatching(/^(cron|github-actions)$/),
      }),
      select: { id: true },
    });
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        endedAt: expect.any(Date),
        durationMs: expect.any(Number),
      }),
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      "cron:heartbeat:last",
      expect.any(String),
    );
  });

  it("throws CronLockHeldError (409) when an active RUNNING row exists within TTL", async () => {
    delegate.findFirst.mockResolvedValue({ id: "exec-live" });
    const fn = jest.fn();

    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockHeldError);
    expect((err as CronLockHeldError).httpStatus).toBe(409);
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

  it("honours a custom TTL cutoff when checking for an active lease", async () => {
    const before = Date.now();
    await withCronLock(
      "create-payout-batch",
      { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
      async () => null,
    );
    const cutoff = delegate.findFirst.mock.calls[0][0].where.startedAt
      .gt as Date;
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(
      LONG_JOB_TTL_MS - 1_000,
    );
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
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { id: "exec-1", status: "RUNNING" },
        data: { startedAt: expect.any(Date) },
      });
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      finish();
      await running;
      const renewals = delegate.updateMany.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(delegate.updateMany).toHaveBeenCalledTimes(renewals);

      // Total elapsed time is ~15 minutes (900_000 ms), not ~5 minutes since the 10-min renewal.
      const finishArgs = delegate.update.mock.calls[0][0];
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

    const finish = delegate.update.mock.calls[0][0];
    expect(finish.where).toEqual({ id: "exec-1" });
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
