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
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ session: { findMany, deleteMany } }),
  },
}));

import {
  enforceSessionCapForUser,
  MAX_CONCURRENT_SESSIONS,
} from "../../lib/auth/session-cap";

beforeEach(() => {
  jest.clearAllMocks();
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

  it("honours a custom cap", async () => {
    findMany.mockResolvedValue([]);

    await enforceSessionCapForUser("u1", 5);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5 }));
  });
});
