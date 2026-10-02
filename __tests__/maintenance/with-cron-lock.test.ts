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

beforeEach(() => {
  jest.clearAllMocks();
  delegate.findFirst.mockResolvedValue(null);
  delegate.create.mockResolvedValue({ id: "exec-1" });
  delegate.update.mockResolvedValue({});
  delegate.updateMany.mockResolvedValue({ count: 1 });
});

describe("withCronLock (Postgres lease on SystemJobExecution)", () => {
  it("acquires a RUNNING row, runs the callback, and marks COMPLETED", async () => {
    const fn = jest.fn().mockResolvedValue("done");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).resolves.toBe("done");

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

  it("re-arms the lease every third of the TTL while the job runs", async () => {
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
      finish();
      await running;
      const renewals = delegate.updateMany.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(delegate.updateMany).toHaveBeenCalledTimes(renewals);
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

  it("fail-open: runs unlocked with a warning when database lock acquisition fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    delegate.create.mockRejectedValue(new Error("db down"));
    const fn = jest.fn().mockResolvedValue("still ran");

    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).resolves.toBe("still ran");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delegate.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
