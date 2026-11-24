/**
 * The single-key appointment lock never orphans its own key and never runs an
 * attempt on a grant it lost:
 *  - a SET that wrote the key and then errored is compare-deleted, so the
 *    retry acquires instead of meeting its own key as contention;
 *  - a renewal that finds the grant taken over throws LOCK_LOST (409).
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
  LockLostError,
  lockAppointment,
  renewAppointmentLock,
  unlockAppointment,
} from "../../utils/appointmentlock";
import type { MockRedis } from "../../lib/redis-mock";

const { client } = (
  jest.requireMock("../../lib/redis") as { __test: { client: MockRedis } }
).__test;
const KEY = "appointment-lock:appt-1";

beforeEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

it("compare-deletes a key its own errored SET wrote, then acquires on the retry", async () => {
  const realSet = client.set.bind(client);
  let first = true;
  jest
    .spyOn(client, "set")
    .mockImplementation(async (...args: Parameters<MockRedis["set"]>) => {
      if (first) {
        first = false;
        // The write lands server-side, then the client sees a timeout.
        await realSet(...args);
        throw new Error("socket timeout");
      }
      return realSet(...args);
    });

  const lock = await lockAppointment("appt-1");
  expect(await client.get(KEY)).toBe(lock.value);
  await unlockAppointment(lock);
  expect(await client.get(KEY)).toBeNull();
});

it("never deletes another writer's key while cleaning up", async () => {
  await client.set(KEY, "someone-else", { px: 60_000 });
  jest.spyOn(client, "set").mockRejectedValue(new Error("socket timeout"));

  await expect(
    lockAppointment("appt-1", 60_000, {
      retryCount: 1,
      retryDelay: 1,
      retryJitter: 0,
      driftFactor: 0.01,
      exponentialBackoff: false,
    }),
  ).rejects.toThrow();
  expect(await client.get(KEY)).toBe("someone-else");
});

it("throws LOCK_LOST when the grant passed to another writer before a renewal", async () => {
  const lock = await lockAppointment("appt-1");
  await client.set(KEY, "another-writer", { px: 60_000 });

  const lost = await renewAppointmentLock(lock).catch((e: unknown) => e);

  expect(lost).toBeInstanceOf(LockLostError);
  expect(lost).toMatchObject({ code: "LOCK_LOST", httpStatus: 409 });
  expect(await client.get(KEY)).toBe("another-writer");
});

describe("a sweep's bounded acquire", () => {
  const { checkRedisHealth } = jest.requireMock("../../lib/redis") as {
    checkRedisHealth: jest.Mock;
  };
  const SWEEP = {
    retryCount: 2,
    retryDelay: 200,
    retryJitter: 0,
    driftFactor: 0.01,
    exponentialBackoff: true,
  };

  it("gives up on a stalled health PING within its call bound and never SETs", async () => {
    checkRedisHealth.mockImplementationOnce(() => new Promise(() => undefined));
    const set = jest.spyOn(client, "set");
    const startedAt = Date.now();

    const outcome = await lockAppointment("appt-1", 60_000, {
      ...SWEEP,
      callTimeoutMs: 100,
    }).catch((e: unknown) => e);

    expect({
      outcome: (outcome as Error).name,
      sets: set.mock.calls.length,
      bounded: Date.now() - startedAt < 1_000,
    }).toEqual({
      outcome: "BookingLockUnavailableError",
      sets: 0,
      bounded: true,
    });
  });

  it("makes no Redis call once the run's deadline has passed", async () => {
    const set = jest.spyOn(client, "set");
    checkRedisHealth.mockClear();

    const outcome = await lockAppointment("appt-1", 60_000, {
      ...SWEEP,
      callTimeoutMs: 1_500,
      deadlineAt: Date.now() - 1,
    }).catch((e: unknown) => e);

    expect({
      outcome: (outcome as Error).name,
      probes: checkRedisHealth.mock.calls.length,
      sets: set.mock.calls.length,
    }).toEqual({ outcome: "AppointmentBusyError", probes: 0, sets: 0 });
  });

  it("stops retrying a contended key rather than wait past the deadline", async () => {
    await client.set(KEY, "someone-else", { px: 60_000 });
    const set = jest.spyOn(client, "set");
    const startedAt = Date.now();

    const outcome = await lockAppointment("appt-1", 60_000, {
      ...SWEEP,
      callTimeoutMs: 1_500,
      deadlineAt: startedAt + 100,
    }).catch((e: unknown) => e);

    expect({
      outcome: (outcome as Error).name,
      sets: set.mock.calls.length,
      bounded: Date.now() - startedAt < 150,
      key: await client.get(KEY),
    }).toEqual({
      outcome: "AppointmentBusyError",
      sets: 1,
      bounded: true,
      key: "someone-else",
    });
  });
});

it("renews a grant that is still ours, and treats no lock as nothing to renew", async () => {
  const lock = await lockAppointment("appt-1");
  await expect(renewAppointmentLock(lock)).resolves.toBeUndefined();
  await expect(renewAppointmentLock(null)).resolves.toBeUndefined();
  await unlockAppointment(lock);
});
