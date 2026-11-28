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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUEST_LOCK_BUDGET_MS,
  extendLock,
  lockConsulteeBooking,
  lockRequestCap,
  lockSlotBatch,
  requestLockBudget,
  requestLockTiers,
  tryLockSlotBatch,
  unlockConsulteeBooking,
  withEventCheckoutLock,
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

describe("a call the request deadline cuts short is out of time, not an outage", () => {
  const closeDeadline = () => ({
    ...requestLockBudget(),
    deadlineAt: Date.now() + 100,
  });

  it("a slow health probe on a single-key tier answers the tier's busy", async () => {
    redis.checkRedisHealth.mockImplementation(hang);
    expect(
      await after(
        lockConsulteeBooking("user-1", undefined, closeDeadline()),
        100,
      ),
    ).toEqual({ error: "ConsulteeBookingBusyError" });
  });

  it("the slot batch sends no acquire once its probe has used the time left", async () => {
    redis.checkRedisHealth.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 200)),
    );
    const acquire = jest.spyOn(client, "eval");
    expect(
      await after(lockSlotBatch(WINDOW, undefined, closeDeadline()), 100),
    ).toEqual({ error: "SlotLockError" });
    await jest.advanceTimersByTimeAsync(200);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("a slot-batch acquire that hangs is cut at the deadline and answers busy", async () => {
    jest.spyOn(client, "eval").mockImplementation(hang);
    expect(
      await after(lockSlotBatch(WINDOW, undefined, closeDeadline()), 100),
    ).toEqual({ error: "SlotLockError" });
  });
});

it("a SET that lands after its acquire gave up is given back", async () => {
  const realSet = client.set.bind(client);
  jest
    .spyOn(client, "set")
    .mockImplementation(
      (...args: Parameters<typeof realSet>) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(realSet(...args)), CALL_BOUND_MS + 500),
        ),
    );
  expect(await after(lockConsulteeBooking("user-1"), CALL_BOUND_MS)).toEqual({
    error: "BookingLockUnavailableError",
  });
  await jest.advanceTimersByTimeAsync(1_000);
  expect(await client.get("consultee-booking:user-1")).toBeNull();
});

describe("a lifecycle door's tiers share the request deadline", () => {
  it("the event tier stops waiting at the deadline and never runs the door", async () => {
    await client.set("event-checkout:WEBINAR:w-1", "a-buyer", { px: 600_000 });
    const door = jest.fn(async () => "ran");
    const waiting = withEventCheckoutLock(
      { appointmentType: "WEBINAR", eventId: "w-1" },
      door,
      { ...requestLockBudget(), deadlineAt: Date.now() + 300 },
    );
    expect(await after(waiting, 300)).toEqual({
      error: "EventCheckoutBusyError",
    });
    expect(door).not.toHaveBeenCalled();
  });

  it("the appointment tier under an event tier waits only for what the event tier left", async () => {
    await client.set("event-checkout:WEBINAR:w-1", "a-buyer", { px: 600_000 });
    await client.set("appointment-lock:appt-1", "a-cancel", { px: 600_000 });
    const tiers = requestLockTiers();
    const startedAt = Date.now();
    // The event key frees late in the budget; the appointment key never does.
    setTimeout(() => void client.del("event-checkout:WEBINAR:w-1"), 5_000);
    const door = tiers.withEventCheckoutLock(
      { appointmentType: "WEBINAR", eventId: "w-1" },
      () => tiers.withAppointmentLock("appt-1", async () => "ran"),
    );
    expect(await after(door, REQUEST_LOCK_BUDGET_MS)).toEqual({
      error: "AppointmentBusyError",
    });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(REQUEST_LOCK_BUDGET_MS);
  });

  it.each([
    "app/api/appointments/[appointmentId]/cancel/route.ts",
    "app/api/appointments/[appointmentId]/reschedule/route.ts",
    "lib/booking/event-retime.ts",
    "lib/booking/class-retime.ts",
  ])("%s takes its lock tiers from one shared deadline", (file) => {
    const source = readFileSync(join(__dirname, "..", "..", file), "utf8");
    expect(source).toMatch(/= requestLockTiers\(\);/);
    expect(source).not.toMatch(
      /import \{[^}]*\bwith(?:Appointment|EventCheckout)Lock\b[^}]*\} from "@\/utils\/appointmentlock"/,
    );
  });
});

it("the consultee key lives one attempt plus slack, not minutes", async () => {
  const lock = await lockConsulteeBooking("user-1");
  expect(lock.ttl).toBeLessThanOrEqual(60_000);
});
