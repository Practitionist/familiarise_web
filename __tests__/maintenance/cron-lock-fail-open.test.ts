/**
 * @jest-environment node
 */

/**
 * #E2 — `failMode: "open"` used to be documented and not implemented.
 *
 * The contract on `CronLockOpts.failMode` has always said an open-mode job
 * should "run unlocked with a warning" when Redis is absent. The mock-Redis
 * branch implemented it. The UNAVAILABLE-Redis branch did not: the health
 * re-probe that tells "someone else holds the lock" apart from "Redis is gone"
 * sat behind `if (opts.failMode === "closed")`, so an open-mode job during a
 * Redis outage took the same `null` token, was never told to check, and threw
 * `CronLockHeldError` — a 409 skip — for a failure that is not a held lock.
 *
 * Five ticker targets were dead for the length of any Redis outage: the
 * outbound-webhook dispatcher, the ledger reconcile backstop, the reschedule
 * proposal expiry, the tentative-occurrence cleanup, and the appointment
 * reminders. The asymmetry is the point of the test: a Redis blip is a
 * platform event, "the job that makes state converge did not run for an hour
 * and nothing said so" is a correctness event, and only the second one costs
 * money.
 */

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  renewLock: jest.fn(),
  isMockRedis: jest.fn(() => false),
  checkRedisHealth: jest.fn(),
  isRedisCircuitOpen: jest.fn(() => false),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: { create: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import redisModule, {
  acquireLock as realAcquireLock,
  releaseLock as realReleaseLock,
  renewLock as realRenewLock,
  isMockRedis as realIsMockRedis,
  checkRedisHealth as realCheckRedisHealth,
  isRedisCircuitOpen as realIsRedisCircuitOpen,
} from "../../lib/redis";
import prisma from "../../lib/prisma";
import {
  withCronLock,
  resetCronHealthCacheForTesting,
  CronLockHeldError,
  CronLockUnavailableError,
} from "../../lib/cron/with-cron-lock";

// Named imports are typed by their production signatures, so the mock handles
// need a `jest.Mock` cast to be driveable. Naming each cast once here keeps
// every case below reading as a statement about behaviour rather than about
// mocking. `redisModule` is the default export — that is what `withCronLock`
// writes the heartbeat through.
const redis = redisModule as unknown as {
  set: jest.Mock;
} & Record<string, jest.Mock>;
const acquireLock = realAcquireLock as unknown as jest.Mock;
const releaseLock = realReleaseLock as unknown as jest.Mock;
const renewLock = realRenewLock as unknown as jest.Mock;
const isMockRedis = realIsMockRedis as unknown as jest.Mock;
const checkRedisHealth = realCheckRedisHealth as unknown as jest.Mock;
const isRedisCircuitOpen = realIsRedisCircuitOpen as unknown as jest.Mock;
const jobExecCreate = prisma.systemJobExecution.create as unknown as jest.Mock;
const jobExecUpdate = prisma.systemJobExecution.update as unknown as jest.Mock;

const JOB = "dispatch-outbound-webhooks";

beforeEach(() => {
  jest.clearAllMocks();
  resetCronHealthCacheForTesting();
  isRedisCircuitOpen.mockReturnValue(false);
  isMockRedis.mockReturnValue(false);
  // `withCronLock` writes the heartbeat through the default export.
  redis.set = jest.fn().mockResolvedValue("OK");
  releaseLock.mockResolvedValue(undefined);
  renewLock.mockResolvedValue(true);
  jobExecCreate.mockResolvedValue({ id: "exec-1" });
  jobExecUpdate.mockResolvedValue({});
});

describe("withCronLock — fail-open during a Redis outage (#E2)", () => {
  it("runs an open-mode job UNLOCKED when the lock could not be taken and Redis is down", async () => {
    // `acquireLock` returns null both for "held" and for "Redis trouble" — the
    // breaker short-circuits to null while OPEN, and during the first four
    // consecutive failures the breaker is still CLOSED while every acquire
    // already fails. The re-probe is the only thing that separates them.
    acquireLock.mockResolvedValue(null);
    checkRedisHealth.mockResolvedValue(false);

    const job = jest.fn().mockResolvedValue("ran");
    const result = await withCronLock(JOB, { failMode: "open" }, job);

    // The behaviour the header comment promised and the code did not have.
    expect(result).toBe("ran");
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("still SKIPS an open-mode job when Redis is healthy and a peer holds the lock", async () => {
    // The other half, and the reason the re-probe exists at all: an open-mode
    // job must not run unlocked just because `acquireLock` said no. A 409 here
    // is the correct answer, and a suite that only checked the fail-open path
    // would happily have removed the distinction.
    acquireLock.mockResolvedValue(null);
    checkRedisHealth.mockResolvedValue(true);

    const job = jest.fn();
    await expect(
      withCronLock(JOB, { failMode: "open" }, job),
    ).rejects.toBeInstanceOf(CronLockHeldError);
    expect(job).not.toHaveBeenCalled();
  });

  it("runs unlocked when the breaker is open even if the health probe answers", async () => {
    // `checkRedisHealth` deliberately BYPASSES the breaker, so a PING can
    // succeed while every write is still being short-circuited. Trusting the
    // probe alone would read that as "someone holds the lock".
    acquireLock.mockResolvedValue(null);
    checkRedisHealth.mockResolvedValue(true);
    isRedisCircuitOpen.mockReturnValue(true);

    const job = jest.fn().mockResolvedValue("ran");
    await expect(withCronLock(JOB, { failMode: "open" }, job)).resolves.toBe(
      "ran",
    );
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("leaves the closed-mode path EXACTLY as it was — a page, not an unlocked run", async () => {
    // Money jobs must not double-run unlocked. This assertion is the reason the
    // fix moved the PROBE rather than removing the branch: an earlier reading of
    // "fail open always" would have passed the three cases above and quietly
    // deleted this one.
    acquireLock.mockResolvedValue(null);
    checkRedisHealth.mockResolvedValue(false);

    const job = jest.fn();
    await expect(
      withCronLock(JOB, { failMode: "closed" }, job),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(job).not.toHaveBeenCalled();
  });

  it("skips a closed-mode job on a genuine held lock, without paging", async () => {
    acquireLock.mockResolvedValue(null);
    checkRedisHealth.mockResolvedValue(true);
    isRedisCircuitOpen.mockReturnValue(false);

    const job = jest.fn();
    await expect(
      withCronLock(JOB, { failMode: "closed" }, job),
    ).rejects.toBeInstanceOf(CronLockHeldError);
  });

  it("uses a LIVE probe on the null-token path, not the 30 s cron-scoped cache", async () => {
    // The asymmetry is load-bearing and easy to "tidy" away. The pre-acquire
    // gate caches for 30 s so one tick's eighteen targets do not each pay a
    // PING; this probe exists to catch Redis going down BETWEEN the gate and
    // this line (#1205-triage). A cached "healthy" here would re-create the very
    // blind spot the pre-acquire gate has, one step later.
    acquireLock.mockResolvedValue(null);
    // Open mode has no pre-acquire gate at all, so the FIRST health call is
    // already this re-probe — and it is live, so a value set once is used once.
    checkRedisHealth.mockResolvedValueOnce(false);

    await withCronLock(JOB, { failMode: "open" }, () => Promise.resolve("ok"));
    expect(checkRedisHealth).toHaveBeenCalledTimes(1);
  });

  it("leaves the mock-Redis branch of the same contract alone", async () => {
    // Pre-existing behaviour, pinned because the fix touched the function it
    // sits in: no Upstash credentials at all must still run an open-mode job.
    isMockRedis.mockReturnValue(true);
    const job = jest.fn().mockResolvedValue("ran");
    await expect(withCronLock(JOB, { failMode: "open" }, job)).resolves.toBe(
      "ran",
    );
    expect(job).toHaveBeenCalledTimes(1);
  });
});
