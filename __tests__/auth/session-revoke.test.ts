/**
 * @jest-environment node
 */

/**
 * The session-revocation choke point (#1856). Ownership rides in the
 * `where` clause (a foreign id matches zero rows — no separate
 * read-then-check), deletes are `deleteMany` so concurrent revokes are
 * 0-count successes.
 */

const deleteMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import {
  revokeAllUserSessions,
  revokeSessionById,
  revokeUserSessionsExcept,
} from "../../lib/auth/session-revoke";

const db = { session: { deleteMany } } as unknown as Parameters<
  typeof revokeAllUserSessions
>[0];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("revokeSessionById (#1856)", () => {
  it("revokes with the ownership predicate in the where clause", async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    await expect(revokeSessionById(db, "u1", "s1")).resolves.toEqual({
      revoked: 1,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "s1", userId: "u1" },
    });
  });

  it("a foreign id revokes nothing — no throw, no separate check", async () => {
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(revokeSessionById(db, "u1", "someone-elses")).resolves.toEqual(
      { revoked: 0 },
    );
  });
});

describe("revokeUserSessionsExcept (#1856)", () => {
  it("keeps the caller's session", async () => {
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(
      revokeUserSessionsExcept(db, "u1", "keep-me"),
    ).resolves.toEqual({ revoked: 3 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { not: "keep-me" } },
    });
  });
});

describe("revokeAllUserSessions (#1856)", () => {
  it("deletes every row for the user", async () => {
    deleteMany.mockResolvedValue({ count: 7 });

    await expect(revokeAllUserSessions(db, "u1")).resolves.toEqual({
      revoked: 7,
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});
