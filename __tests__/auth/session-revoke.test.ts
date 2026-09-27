/**
 * @jest-environment node
 */

/**
 * The session-revocation choke point (#1856). Ownership rides in the
 * `where` clause (a foreign id matches zero rows — no separate
 * read-then-check), deletes are `deleteMany` so concurrent revokes are
 * 0-count successes, and the cross-device signal is best-effort.
 */

const deleteMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

const redisIncr = jest.fn();
const redisPexpire = jest.fn();
const redisGet = jest.fn();
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    incr: (...a: unknown[]) => redisIncr(...a),
    pexpire: (...a: unknown[]) => redisPexpire(...a),
    get: (...a: unknown[]) => redisGet(...a),
  },
}));

const throttledCapture = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  __esModule: true,
  captureThrottled: (...a: unknown[]) => throttledCapture(...a),
}));

import {
  revokeAllUserSessions,
  revokeSessionById,
  revokeUserSessionsExcept,
  readRevocationSignal,
  revocationSignalKey,
  signalRevocation,
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

describe("revocation signal (#1856)", () => {
  it("bumps the per-user counter with a 24h TTL", async () => {
    redisIncr.mockResolvedValue(4);
    redisPexpire.mockResolvedValue(true);

    await signalRevocation("u1");

    expect(redisIncr).toHaveBeenCalledWith(revocationSignalKey("u1"));
    expect(redisPexpire).toHaveBeenCalledWith(
      revocationSignalKey("u1"),
      24 * 60 * 60 * 1000,
    );
  });

  it("never throws — a Redis blip is throttled-reported and swallowed", async () => {
    redisIncr.mockRejectedValue(new Error("READONLY"));

    await expect(signalRevocation("u1")).resolves.toBeUndefined();
    expect(throttledCapture).toHaveBeenCalledWith(
      "session:signalRevocation",
      expect.any(Error),
      expect.objectContaining({ subsystem: "auth" }),
    );
  });

  it("reads the counter, defaulting an absent key to 0", async () => {
    redisGet.mockResolvedValue(null);

    await expect(readRevocationSignal("u1")).resolves.toBe(0);
    expect(redisGet).toHaveBeenCalledWith(revocationSignalKey("u1"));
  });

  it("fail-open: an unreadable signal is null, never a revocation", async () => {
    redisGet.mockRejectedValue(new Error("timeout"));

    await expect(readRevocationSignal("u1")).resolves.toBeNull();
  });
});
