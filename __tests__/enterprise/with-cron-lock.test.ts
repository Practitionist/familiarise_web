/**
 * @jest-environment node
 */

import {
  withCronLock,
  CronLockHeldError,
  CronLockUnavailableError,
  LONG_JOB_TTL_MS,
} from "../../lib/cron/with-cron-lock";
import {
  acquireLock,
  releaseLock,
  isMockRedis,
  checkRedisHealth,
} from "../../lib/redis";

jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn(),
  checkRedisHealth: jest.fn(),
}));

const mockAcquire = acquireLock as jest.Mock;
const mockRelease = releaseLock as jest.Mock;
const mockIsMock = isMockRedis as jest.Mock;
const mockHealth = checkRedisHealth as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMock.mockReturnValue(false);
  mockHealth.mockResolvedValue(true);
  mockAcquire.mockResolvedValue("token-1");
});

describe("withCronLock", () => {
  it("acquires with the #476 key shape, runs, and releases", async () => {
    const fn = jest.fn().mockResolvedValue("done");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).resolves.toBe("done");
    expect(mockAcquire).toHaveBeenCalledWith("cron:lock:dunning", 15 * 60 * 1000);
    expect(mockRelease).toHaveBeenCalledWith("cron:lock:dunning", "token-1");
  });

  it("honours a custom TTL", async () => {
    await withCronLock(
      "create-payout-batch",
      { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
      async () => null,
    );
    expect(mockAcquire).toHaveBeenCalledWith(
      "cron:lock:create-payout-batch",
      LONG_JOB_TTL_MS,
    );
  });

  it("throws CronLockHeldError (409) when the lock is held — job skips", async () => {
    mockAcquire.mockResolvedValue(null);
    const fn = jest.fn();
    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockHeldError);
    expect((err as CronLockHeldError).httpStatus).toBe(409);
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases even when the job throws", async () => {
    const boom = new Error("boom");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: refuses to run on mock Redis (pages via exit 1)", async () => {
    mockIsMock.mockReturnValue(true);
    const fn = jest.fn();
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-closed: refuses to run when Redis is unhealthy (circuit open)", async () => {
    mockHealth.mockResolvedValue(false);
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => null),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("fail-open: runs unlocked on mock Redis with a warning", async () => {
    mockIsMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue(42);
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).resolves.toBe(42);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("fail-open: still skips when the lock is genuinely held", async () => {
    mockAcquire.mockResolvedValue(null);
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, async () => 1),
    ).rejects.toBeInstanceOf(CronLockHeldError);
  });
});
