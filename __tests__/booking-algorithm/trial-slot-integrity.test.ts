/**
 * #1169 PR 1 — trial slot integrity + interval-granular locking.
 *
 * Four contracts, each of which has silently failed before:
 * 1. slotAtomStarts makes OVERLAPPING intervals share lock keys even when
 *    their start instants differ (the double-charge shape: 10:00–12:00 vs
 *    11:00–12:00).
 * 2. The trial route writes consultantProfileId on its slot (without it the
 *    slot escapes the occurrence_no_confirmed_overlap exclusion constraint, #1093
 *    §1) and locks under the SHARED slot-booking namespace (the retired
 *    trial-slot-booking namespace contended with nothing).
 * 3. Capacity reads whose query forgot the user include throw loudly instead
 *    of silently counting zero registrants for a sold-out event.
 * 4. lockSlotInterval is all-or-nothing over its atoms (#1170 review):
 *    contention rolls back every atom already held and names the conflicting
 *    atom in SlotLockError; Redis-down fails CLOSED (typed 503) before any
 *    atom is taken; and a multi-atom acquisition re-arms every atom to a
 *    fresh shared deadline, aborting if any ownership was already lost.
 */

import fs from "fs";
import path from "path";

// The repository's in-memory Redis (it runs the slot-batch scripts), wrapped so
// a test can count round trips and fail closed.
jest.mock("../../lib/redis", () => {
  const { MockRedis } = jest.requireActual("../../lib/redis-mock");
  const client = new MockRedis();
  const evalCalls: string[][] = [];
  const realEval = client.eval.bind(client);
  client.eval = async (script: string, keys: string[], args: string[]) => {
    evalCalls.push(keys);
    return realEval(script, keys, args);
  };
  return {
    __esModule: true,
    default: client,
    withCircuitBreaker: jest.fn(async (fn: () => unknown) => fn()),
    checkRedisHealth: jest.fn(async () => true),
    __test: { client, evalCalls },
  };
});

import {
  slotAtomStarts,
  lockSlotInterval,
  lockSlotBooking,
  extendSlotInterval,
  unlockSlotInterval,
  tryLockSlotBatch,
  BookingLockUnavailableError,
} from "../../utils/appointmentlock";
import { SlotLockError } from "../../utils/errors/SlotLockError";
import type { MockRedis } from "../../lib/redis-mock";
import {
  getWebinarCapacity,
  getClassCapacity,
} from "../../lib/events/capacity";

const redisMock = jest.requireMock("../../lib/redis") as {
  checkRedisHealth: jest.Mock;
  __test: { client: MockRedis; evalCalls: string[][] };
};
const redisTest = redisMock.__test;

describe("slotAtomStarts — interval → 30-minute atom keys", () => {
  const at = (iso: string) => new Date(iso);

  it("covers an aligned interval with one atom per half hour", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    );
    expect(atoms.map((a) => a.toISOString())).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("makes overlapping intervals with different starts share atoms", () => {
    const a = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const b = slotAtomStarts(
      at("2026-09-01T11:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const shared = b.filter((atom) => a.includes(atom));
    expect(shared).toEqual([
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("floors an unaligned start to the half-hour grid so it still collides", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:10:00.000Z"),
      at("2026-09-01T10:40:00.000Z"),
    ).map((d) => d.toISOString());
    expect(atoms).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
    ]);
  });

  it("returns no atoms for an empty interval", () => {
    const t = at("2026-09-01T10:00:00.000Z");
    expect(slotAtomStarts(t, t)).toHaveLength(0);
  });
});

describe("trial time writer source contract", () => {
  const writerSource = fs.readFileSync(
    path.join(process.cwd(), "lib/trials/book-trial.ts"),
    "utf8",
  );

  it("stamps consultantProfileId on the trial session create", () => {
    expect(writerSource).toContain(
      "consultantProfileId: args.consultantProfileId",
    );
  });

  it("locks under the shared slot-booking namespace, not a trial-only one", () => {
    expect(writerSource).toContain("lockSlotBatch");
    expect(writerSource).not.toContain("trial-slot-booking");
    expect(writerSource).not.toContain("lockTrialSlot");
  });

  const checkSource = fs.readFileSync(
    path.join(process.cwd(), "lib/trials/slot-check.ts"),
    "utf8",
  );

  it("validates availability on the transaction client, not the global one", () => {
    expect(writerSource).toMatch(/trialWindowRefusal\(\s*tx,/);
    expect(checkSource).toContain("db: Tx");
    expect(checkSource).toMatch(/validateSlotAvailability\(\s*db,/);
  });

  it("checks both calendars with checkout's own predicates", () => {
    expect(checkSource).toContain("buildConsultantOccupancyWhere(");
    expect(checkSource).toContain("consulteeHasOverlappingSession(");
  });

  it("takes the consultee lock before the slot lock (checkout's global order)", () => {
    const consulteeAt = writerSource.search(/await lockConsulteeBooking\(/);
    const slotAt = writerSource.search(/await lockSlotBatch\(/);
    expect(consulteeAt).toBeGreaterThan(-1);
    expect(slotAt).toBeGreaterThan(-1);
    expect(consulteeAt).toBeLessThan(slotAt);
    expect(writerSource).toContain("unlockConsulteeBooking");
  });
});

describe("lock module source contract", () => {
  const lockSource = fs.readFileSync(
    path.join(process.cwd(), "utils/appointmentlock.ts"),
    "utf8",
  );

  it("has retired the trial-slot-booking namespace entirely", () => {
    // Key CONSTRUCTION is what must be gone; the tombstone comment may still
    // name the namespace.
    expect(lockSource).not.toContain("`trial-slot-booking:${");
    expect(lockSource).not.toContain("export async function lockTrialSlot");
  });
});

/**
 * Behavioral lock semantics against the in-memory SET NX / eval fake (#1170
 * review). Retry backoff is exponential and would burn real wall-clock, so the
 * contention case runs under fake timers and drains the delays explicitly —
 * same pattern as event-checkout-lock-fail-closed.test.ts.
 */
async function settleWithTimers<T>(p: Promise<T>): Promise<T | Error> {
  const tracked = p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );
  // 6 attempts per atom; drain every pending backoff timer until it settles.
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await jest.runAllTimersAsync();
  }
  const r = await tracked;
  return r.ok ? r.v : r.e;
}

describe("lockSlotInterval — one atomic batch over every atom", () => {
  const CID = "consultant-1";
  const key = (iso: string) => `slot-booking:${CID}:${iso}`;
  const START = "2026-09-01T10:00:00.000Z";

  beforeEach(() => {
    redisTest.client.clear();
    redisTest.evalCalls.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("takes every atom in one round trip under one shared value", async () => {
    const locks = await lockSlotInterval(
      CID,
      new Date(START),
      new Date("2026-09-01T11:00:00.000Z"),
    );

    expect(locks.map((l) => l.key)).toEqual([
      key("2026-09-01T10:00:00.000Z"),
      key("2026-09-01T10:30:00.000Z"),
    ]);
    for (const lock of locks) {
      expect(await redisTest.client.get(lock.key)).toBe(lock.value);
      expect(await redisTest.client.pttl(lock.key)).toBeGreaterThan(50_000);
    }
    expect(redisTest.evalCalls).toHaveLength(1);
  });

  it("sets nothing on contention and names the held atom", async () => {
    jest.useFakeTimers();
    // A foreign writer holds the MIDDLE atom of 10:00–11:30.
    const heldISO = "2026-09-01T10:30:00.000Z";
    await redisTest.client.set(key(heldISO), "someone-else", { px: 3_600_000 });

    const err = await settleWithTimers(
      lockSlotBooking(CID, START, "2026-09-01T11:30:00.000Z"),
    );

    expect(err).toBeInstanceOf(SlotLockError);
    expect(err).toMatchObject({
      consultantId: CID,
      slotTime: heldISO,
      retryAfterSeconds: 60,
    });
    // The copy names neither the profile nor the instant (either may be the buyer's own).
    expect((err as Error).message).not.toContain(CID);
    expect((err as Error).message).not.toContain(heldISO);
    // All-or-nothing: no atom around the held one was ever set.
    expect(await redisTest.client.get(key(START))).toBeNull();
    expect(
      await redisTest.client.get(key("2026-09-01T11:00:00.000Z")),
    ).toBeNull();
    expect(await redisTest.client.get(key(heldISO))).toBe("someone-else");
  });

  it("fails CLOSED with a typed 503 when Redis is unhealthy, before taking any atom", async () => {
    redisMock.checkRedisHealth.mockResolvedValueOnce(false);

    const err = await lockSlotBooking(
      CID,
      START,
      "2026-09-01T11:00:00.000Z",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingLockUnavailableError);
    expect((err as BookingLockUnavailableError).httpStatus).toBe(503);
    expect((err as BookingLockUnavailableError).code).toBe(
      "BOOKING_LOCK_UNAVAILABLE",
    );
    expect(redisTest.client.size()).toBe(0);
  });

  it("gives back a batch whose acquire landed after the timeout", async () => {
    jest.useFakeTimers();
    const realEval = redisTest.client.eval;
    // The acquire reaches Redis only after the caller has given up on it.
    redisTest.client.eval = (async (
      script: string,
      keys: string[],
      args: string[],
    ) => {
      redisTest.client.eval = realEval;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return realEval(script, keys, args);
    }) as typeof realEval;

    const err = await settleWithTimers(
      tryLockSlotBatch([
        {
          consultantProfileId: CID,
          startsAt: START,
          endsAt: "2026-09-01T11:00:00.000Z",
        },
      ]),
    );

    expect(err).toBeInstanceOf(BookingLockUnavailableError);
    // The late acquire set both atoms; the follow-up release removed them.
    expect(await redisTest.client.get(key(START))).toBeNull();
    expect(
      await redisTest.client.get(key("2026-09-01T10:30:00.000Z")),
    ).toBeNull();
  });

  it("renews only while every atom is still ours", async () => {
    const locks = await lockSlotInterval(
      CID,
      START,
      "2026-09-01T11:00:00.000Z",
    );
    expect(await extendSlotInterval(locks, 90_000)).toBe(true);

    await redisTest.client.del(locks[1].key);
    await redisTest.client.set(locks[1].key, "thief", { px: 60_000 });
    expect(await extendSlotInterval(locks, 90_000)).toBe(false);

    await unlockSlotInterval(locks);
    // Release is compare-value: the thief's atom survives, ours is gone.
    expect(await redisTest.client.get(locks[0].key)).toBeNull();
    expect(await redisTest.client.get(locks[1].key)).toBe("thief");
  });
});

describe("capacity include-trap (#676 CN-4)", () => {
  const plan = { maxParticipants: 10 };

  it("throws when the webinar appointment was loaded without participants", () => {
    expect(() =>
      getWebinarCapacity({
        webinar: {
          maxParticipants: null,
          appointment: {} as { participants?: { userId: string }[] },
        },
        plan,
      }),
    ).toThrow(/participants was not included/);
  });

  it("counts live seats when participants are present (#1554)", () => {
    const capacity = getWebinarCapacity({
      webinar: {
        maxParticipants: null,
        appointment: {
          participants: [
            { userId: "u1", status: "CONFIRMED" },
            { userId: "u2", status: "HELD" },
            { userId: "u3", status: "CANCELLED" },
          ],
        },
      },
      plan,
    });
    expect(capacity.registered).toBe(2);
    expect(capacity.remaining).toBe(8);
    expect(capacity.isFull).toBe(false);
  });

  it("throws for class capacity when the wrapper was loaded without participants", () => {
    expect(() =>
      getClassCapacity({
        classInstance: {
          maxParticipants: 1,
          appointment: {} as { participants?: { userId: string }[] },
        },
        plan,
      }),
    ).toThrow(/participants was not included/);
  });
});
