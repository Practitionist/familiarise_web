/**
 * @jest-environment node
 */

/**
 * Concurrent-session cap (#1856). The enforcement must keep exactly the N
 * newest sessions under a TOTAL order (createdAt ties are real — two
 * sign-ins in the same millisecond), and a concurrent second enforcement
 * must be a 0-count delete, not a throw.
 */

const findMany = jest.fn();
const deleteMany = jest.fn();
const transaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { Prisma } from "@prisma/client";
import {
  enforceSessionCapForUser,
  MAX_CONCURRENT_SESSIONS,
} from "../../lib/auth/session-cap";

beforeEach(() => {
  jest.clearAllMocks();
  // Default to the happy shape: one pass, one Serializable transaction.
  transaction.mockImplementation(
    async (fn: (tx: unknown) => unknown, _opts?: unknown) =>
      fn({ session: { findMany, deleteMany } }),
  );
});

describe("enforceSessionCapForUser (#1856)", () => {
  it("does nothing when the user is under the cap", async () => {
    findMany.mockResolvedValue([]);

    const out = await enforceSessionCapForUser("u1");

    expect(out).toEqual({ evicted: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        skip: MAX_CONCURRENT_SESSIONS,
      }),
    );
  });

  it("evicts the overflow with a total order (createdAt tie broken by id)", async () => {
    findMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);
    deleteMany.mockResolvedValue({ count: 2 });

    const out = await enforceSessionCapForUser("u1", 3);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 3,
        select: { id: true },
      }),
    );
    // The userId predicate rides along so a poisoned id list can never
    // delete across users.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1", "old-2"] }, userId: "u1" },
    });
    expect(out).toEqual({ evicted: 2 });
  });

  it("a concurrent second enforcement is a 0-count success, not a throw", async () => {
    findMany.mockResolvedValue([{ id: "gone" }]);
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(enforceSessionCapForUser("u1", 1)).resolves.toEqual({
      evicted: 0,
    });
  });

  it("never evicts the just-created session, even when it ties for newest", async () => {
    // Same-millisecond sign-ins share createdAt; random ids decide the
    // order, so without the reservation the fresh session could fall
    // outside the keep window and the user would hold a cookie for a
    // deleted row.
    findMany.mockResolvedValue([{ id: "old-1" }]);
    deleteMany.mockResolvedValue({ count: 1 });

    const out = await enforceSessionCapForUser("u1", 10, "fresh");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", id: { not: "fresh" } },
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1"] }, userId: "u1" },
    });
    expect(out).toEqual({ evicted: 1 });
  });

  it("honours a custom cap", async () => {
    findMany.mockResolvedValue([]);

    await enforceSessionCapForUser("u1", 5);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5 }));
  });

  it("bounds the overflow fetch so abuse cannot OOM the pass", async () => {
    findMany.mockResolvedValue([]);

    await enforceSessionCapForUser("u1");

    // One bounded pass per sign-in converges (eventual consistency);
    // an unbounded skip would materialize a stuffing victim's rows.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  // --- review follow-up: the two properties the module docstring leans
  // on were asserted nowhere, so deleting the retry loop or dropping the
  // isolation level left this suite green.

  it("runs the pass inside a SERIALIZABLE transaction", async () => {
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 0 });

    await enforceSessionCapForUser("u1");

    // Two simultaneous sign-ins both run this. Without Serializable they
    // can each read the same overflow set and one delete silently loses
    // rows the other already counted, so the cap stops holding exactly.
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("repeats the pass while a full batch comes back, then stops", async () => {
    // A full batch means there may be more overflow behind it. Three full
    // batches then a short one: the loop must run four passes, not one.
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}` }));
    findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: "last" }]);
    deleteMany.mockResolvedValue({ count: 200 });

    const out = await enforceSessionCapForUser("u1", 10);

    expect(findMany).toHaveBeenCalledTimes(4);
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(out).toEqual({ evicted: 800 });
  });

  it("converges a large overflow inside the sign-in that triggered it", async () => {
    // 1,000 stuffed rows = five full passes. The module claims 5 x 200
    // converges that; this pins the claim.
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}` }));
    for (let i = 0; i < 5; i++) findMany.mockResolvedValueOnce(full);
    deleteMany.mockResolvedValue({ count: 200 });

    const out = await enforceSessionCapForUser("u1", 10);

    expect(findMany).toHaveBeenCalledTimes(5);
    expect(out.evicted).toBe(1000);
  });

  it("stops at the pass ceiling rather than looping on a permanent overflow", async () => {
    // A full batch forever (a concurrent writer keeps refilling, or the
    // predicate never drains) must not spin: the ceiling bounds total
    // work per sign-in and convergence continues on the next sign-in.
    findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}` })),
    );
    deleteMany.mockResolvedValue({ count: 200 });

    const out = await enforceSessionCapForUser("u1", 10);

    expect(findMany).toHaveBeenCalledTimes(5);
    expect(out.evicted).toBe(1000);
  });

  it("retries a serialisation failure and still converges", async () => {
    // P2034 is transient by definition; `withSerializableRetry` is real
    // here (not mocked), so a first-pass abort must re-run the pass.
    // It only recognises a real `PrismaClientKnownRequestError`, so the
    // throw has to be constructed as one.
    let calls = 0;
    transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown, _opts?: unknown) => {
        calls += 1;
        if (calls === 1) {
          throw new Prisma.PrismaClientKnownRequestError(
            "serialization failure",
            { code: "P2034", clientVersion: "test" },
          );
        }
        return fn({ session: { findMany, deleteMany } });
      },
    );
    findMany.mockResolvedValue([{ id: "old" }]);
    deleteMany.mockResolvedValue({ count: 1 });

    const out = await enforceSessionCapForUser("u1", 1);

    expect(out).toEqual({ evicted: 1 });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
