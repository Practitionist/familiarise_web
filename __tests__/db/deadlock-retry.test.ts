/**
 * @jest-environment node
 */

// 40P01 deadlock_detected: the driver adapter pinned here has no case for it, so
// it reaches us unmapped where 40001 arrives pre-classified as P2034. Pins both
// halves of the widened retry condition — deadlocks ARE retried, and nothing
// that is not a rollback is. Plain error objects only; no database.
import { Prisma } from "@prisma/client";

import { isDeadlock } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const p2034 = () =>
  new Prisma.PrismaClientKnownRequestError("serialization failure", {
    code: "P2034",
    clientVersion: "test",
  });

// The adapter's generic `kind: "postgres"` fall-through for an unrecognised code.
const adapterDeadlock = () =>
  new Prisma.PrismaClientUnknownRequestError("deadlock detected", {
    clientVersion: "test",
  });

function withAdapterCause(err: unknown, originalCode: string): unknown {
  const e = err as {
    meta: { driverAdapterError: { cause: { originalCode: string } } };
  };
  e.meta = { driverAdapterError: { cause: { originalCode } } };
  return e;
}

describe("isDeadlock", () => {
  it("matches 40P01 in meta.code (raw-query path)", () => {
    expect(isDeadlock({ code: "P2010", meta: { code: "40P01" } })).toBe(true);
  });

  it("matches 40P01 in driverAdapterError.cause.originalCode (adapter path)", () => {
    expect(isDeadlock(withAdapterCause(adapterDeadlock(), "40P01"))).toBe(true);
  });

  it("matches the bare 40P01 token in the message", () => {
    expect(isDeadlock({ message: "ERROR: 40P01: deadlock detected" })).toBe(
      true,
    );
  });

  it("does not match the SSI abort, which arrives as P2034 instead", () => {
    expect(isDeadlock(p2034())).toBe(false);
    expect(
      isDeadlock(withAdapterCause(adapterDeadlock(), "40001")),
    ).toBe(false);
  });

  it("does not match a business rejection or an unrelated SQLSTATE", () => {
    // A 409 that happens to name a state machine transition.
    expect(isDeadlock(new Error("VERSION_CONFLICT: 409"))).toBe(false);
    expect(isDeadlock({ code: "P2002" })).toBe(false);
    expect(isDeadlock({ code: "P2024", meta: { code: "53300" } })).toBe(false);
    expect(isDeadlock(new Error("deadlock detected"))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });
});

describe("withSerializableRetry with deadlocks", () => {
  it("retries a 40P01 and succeeds on a later attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(withAdapterCause(adapterDeadlock(), "40P01"))
      .mockResolvedValue("ok");
    await expect(withSerializableRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows the deadlock", async () => {
    const fn = jest
      .fn()
      .mockRejectedValue(withAdapterCause(adapterDeadlock(), "40P01"));
    await expect(withSerializableRetry(fn, 2)).rejects.toMatchObject({
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("still propagates a business rejection on the first attempt", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("IllegalTransitionError"));
    await expect(withSerializableRetry(fn)).rejects.toThrow(
      "IllegalTransitionError",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
