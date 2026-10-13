/**
 * @jest-environment node
 */

// 40P01 has no adapter-pg 7.7 mapping, so Prisma rethrows the raw
// DriverAdapterError; 40001 arrives pre-classified as P2034. No database.
import { Prisma } from "@prisma/client";

import { isDeadlock } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const p2034 = () =>
  new Prisma.PrismaClientKnownRequestError("serialization failure", {
    code: "P2034",
    clientVersion: "test",
  });

// The exact shape @prisma/driver-adapter-utils' DriverAdapterError has after
// adapter-pg's convertDriverError default arm (kind "postgres").
const adapterError = (code: string, msg: string) =>
  Object.assign(new Error(msg), {
    name: "DriverAdapterError",
    cause: {
      kind: "postgres",
      code,
      severity: "ERROR",
      message: msg,
      originalCode: code,
      originalMessage: msg,
    },
  });
const adapterDeadlock = () => adapterError("40P01", "deadlock detected");

describe("isDeadlock", () => {
  it("matches 40P01 in meta.code (raw-query path)", () => {
    expect(isDeadlock({ code: "P2010", meta: { code: "40P01" } })).toBe(true);
  });

  it("matches the raw DriverAdapterError Prisma rethrows for 40P01", () => {
    expect(isDeadlock(adapterDeadlock())).toBe(true);
  });

  it("matches 40P01 under meta.driverAdapterError (P2010 raw-query path)", () => {
    expect(
      isDeadlock({
        code: "P2010",
        meta: { driverAdapterError: adapterDeadlock() },
      }),
    ).toBe(true);
  });

  it("matches the bare 40P01 token in the message", () => {
    expect(isDeadlock({ message: "ERROR: 40P01: deadlock detected" })).toBe(
      true,
    );
  });

  it("does not match the SSI abort, which arrives as P2034 instead", () => {
    expect(isDeadlock(p2034())).toBe(false);
    expect(isDeadlock(adapterError("40001", "could not serialize"))).toBe(
      false,
    );
  });

  it("does not match a business rejection or an unrelated SQLSTATE", () => {
    // A 409 that happens to name a state machine transition.
    expect(isDeadlock(new Error("VERSION_CONFLICT: 409"))).toBe(false);
    expect(isDeadlock({ code: "P2002" })).toBe(false);
    expect(isDeadlock({ code: "P2024", meta: { code: "53300" } })).toBe(false);
    expect(isDeadlock(adapterError("23P01", "deadlock detected"))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });
});

describe("withSerializableRetry with deadlocks", () => {
  it("retries a 40P01 and succeeds on a later attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(adapterDeadlock())
      .mockResolvedValue("ok");
    await expect(withSerializableRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows the deadlock", async () => {
    const fn = jest.fn().mockRejectedValue(adapterDeadlock());
    await expect(withSerializableRetry(fn, 2)).rejects.toMatchObject({
      name: "DriverAdapterError",
      cause: { originalCode: "40P01" },
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
