/**
 * Every Redis call a booking lock makes is cut at its bound, a hung Redis fails
 * closed, and the lock tiers of one request share one deadline.
 */
jest.mock("../../lib/redis", () => {
  const { MockRedis } = jest.requireActual("../../lib/redis-mock");
  const client = new MockRedis();
  return {
    __esModule: true,
    default: client,
    withCircuitBreaker: jest.fn(async (fn: () => unknown) => fn()),
    checkRedisHealth: jest.fn(async () => true),
    __test: { client },
  };
});

import {
  REQUEST_LOCK_BUDGET_MS,
  extendLock,
  lockConsulteeBooking,
  lockRequestCap,
  lockSlotBatch,
  requestLockBudget,
  tryLockSlotBatch,
  unlockConsulteeBooking,
} from "../../utils/appointmentlock";
import type { MockRedis } from "../../lib/redis-mock";

const redis = jest.requireMock("../../lib/redis") as {
  checkRedisHealth: jest.Mock;
  __test: { client: MockRedis };
};
const { client } = redis.__test;

const hang = () => new Promise<never>(() => undefined);
const CALL_BOUND_MS = 1_500;
const WINDOW = [
  {
    consultantProfileId: "cp-1",
    startsAt: "2027-03-01T10:00:00.000Z",
    endsAt: "2027-03-01T10:30:00.000Z",
  },
];

/** What `pending` settled to after `ms` of fake time, or "pending". */
async function after<T>(pending: Promise<T>, ms: number) {
  const settled = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).name }),
  );
  await jest.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("pending" as const)]);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.restoreAllMocks();
  client.clear();
  redis.checkRedisHealth.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  jest.useRealTimers();
});

describe("a hung Redis call is cut at its bound", () => {
  it("an acquire on the request path answers lock-unavailable (503), never hangs", async () => {
    jest.spyOn(client, "set").mockImplementation(hang);
    expect(await after(lockConsulteeBooking("user-1"), CALL_BOUND_MS)).toEqual({
      error: "BookingLockUnavailableError",
    });
  });

  it("a release returns", async () => {
    const lock = await lockConsulteeBooking("user-1");
    jest.spyOn(client, "eval").mockImplementation(hang);
    expect(await after(unlockConsulteeBooking(lock), CALL_BOUND_MS)).toEqual({
      value: undefined,
    });
  });

  it("a renewal reads as a lost grant", async () => {
    const lock = await lockConsulteeBooking("user-1");
    jest.spyOn(client, "eval").mockImplementation(hang);
    expect(await after(extendLock(lock, 45_000), CALL_BOUND_MS)).toEqual({
      value: false,
    });
  });

  it("the slot batch's health probe answers lock-unavailable and takes no atom", async () => {
    redis.checkRedisHealth.mockImplementation(hang);
    const acquire = jest.spyOn(client, "eval");
    expect(await after(tryLockSlotBatch(WINDOW), CALL_BOUND_MS)).toEqual({
      error: "BookingLockUnavailableError",
    });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("the lock tiers of one request share one deadline", () => {
  it("a contended first tier spends the budget, and the later tiers refuse without a Redis call", async () => {
    await client.set("request-cap:cp-1", "someone-else", { px: 600_000 });
    const startedAt = Date.now();
    const budget = requestLockBudget();

    expect(
      await after(
        lockRequestCap("cp-1", undefined, budget),
        REQUEST_LOCK_BUDGET_MS,
      ),
    ).toEqual({ error: "RequestCapBusyError" });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(REQUEST_LOCK_BUDGET_MS);

    const set = jest.spyOn(client, "set");
    const evaluated = jest.spyOn(client, "eval");
    redis.checkRedisHealth.mockClear();
    expect(
      await after(lockConsulteeBooking("user-1", undefined, budget), 0),
    ).toEqual({ error: "ConsulteeBookingBusyError" });
    expect(await after(lockSlotBatch(WINDOW, undefined, budget), 0)).toEqual({
      error: "SlotLockError",
    });
    expect({
      sets: set.mock.calls.length,
      evals: evaluated.mock.calls.length,
      probes: redis.checkRedisHealth.mock.calls.length,
    }).toEqual({ sets: 0, evals: 0, probes: 0 });
  });

  it("a held slot atom is waited on only until the deadline", async () => {
    await tryLockSlotBatch(WINDOW, 600_000);
    const waiting = lockSlotBatch(WINDOW, undefined, {
      ...requestLockBudget(),
      deadlineAt: Date.now() + 300,
    });
    expect(await after(waiting, 300)).toEqual({ error: "SlotLockError" });
  });
});

it("the consultee key lives one attempt plus slack, not minutes", async () => {
  const lock = await lockConsulteeBooking("user-1");
  expect(lock.ttl).toBeLessThanOrEqual(60_000);
});
