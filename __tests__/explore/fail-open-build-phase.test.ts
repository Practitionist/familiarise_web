/**
 * Fail-open is only safe where the degraded result reaches the ONE request that
 * hit the failure. Build output and the ISR/durable cache are both persisted and
 * replayed to every later visitor, so degrading is opt-in per call site
 * (`perRequest`) and everything else fails CLOSED. (#932, #1119)
 */
import { PHASE_PRODUCTION_BUILD } from "next/constants";

import {
  emptyOnTransientDbError,
  fallbackOnTransientDbError,
  isTransientDbError,
  withTransientRetry,
} from "@/lib/data/fail-open";

const transient = Object.assign(new Error("pool timeout"), { code: "P2024" });
const real = new Error("Cannot read properties of undefined (reading 'map')");

const originalPhase = process.env.NEXT_PHASE;

afterEach(() => {
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
});

function setBuildPhase(on: boolean) {
  if (on) process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;
  else delete process.env.NEXT_PHASE;
}

describe("fail-open transient classification", () => {
  it("treats pool timeouts as transient and mapper bugs as real", () => {
    expect(isTransientDbError(transient)).toBe(true);
    expect(isTransientDbError(real)).toBe(false);
  });
});

describe("cacheable render (fail closed by default)", () => {
  beforeEach(() => setBuildPhase(false));

  // The #1119 regression guard: without `perRequest`, a transient failure must
  // NOT become a 200 that Netlify writes into the durable cache.
  it("emptyOnTransientDbError rethrows when the call site is not per-request", () => {
    expect(() => emptyOnTransientDbError("ctx")(transient)).toThrow(transient);
  });

  it("fallbackOnTransientDbError rethrows when the call site is not per-request", () => {
    expect(() => fallbackOnTransientDbError("ctx", null)(transient)).toThrow(
      transient,
    );
  });
});

describe("per-request render (fail open)", () => {
  beforeEach(() => setBuildPhase(false));

  it("emptyOnTransientDbError degrades a transient error to []", () => {
    expect(
      emptyOnTransientDbError("ctx", { perRequest: true })(transient),
    ).toEqual([]);
  });

  it("fallbackOnTransientDbError degrades a transient error to the fallback", () => {
    expect(
      fallbackOnTransientDbError(
        "ctx",
        { total: 0 },
        { perRequest: true },
      )(transient),
    ).toEqual({ total: 0 });
  });

  it("still rethrows non-transient errors", () => {
    expect(() =>
      emptyOnTransientDbError("ctx", { perRequest: true })(real),
    ).toThrow(real);
    expect(() =>
      fallbackOnTransientDbError("ctx", null, { perRequest: true })(real),
    ).toThrow(real);
  });
});

describe("production build phase (fail closed even when opted in)", () => {
  beforeEach(() => setBuildPhase(true));

  it("emptyOnTransientDbError rethrows rather than baking an empty page", () => {
    expect(() =>
      emptyOnTransientDbError("ctx", { perRequest: true })(transient),
    ).toThrow(transient);
  });

  it("fallbackOnTransientDbError rethrows rather than baking a fallback page", () => {
    expect(() =>
      fallbackOnTransientDbError("ctx", null, { perRequest: true })(transient),
    ).toThrow(transient);
  });
});

describe("withTransientRetry", () => {
  it("retries once at request time and succeeds on the second attempt", async () => {
    setBuildPhase(false);
    const read = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ok");
    await expect(withTransientRetry(read)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after one request-time retry so a saturated pooler surfaces fast", async () => {
    setBuildPhase(false);
    const read = jest.fn().mockRejectedValue(transient);
    await expect(withTransientRetry(read)).rejects.toThrow(transient);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure during the build and succeeds", async () => {
    setBuildPhase(true);
    const read = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ok");
    await expect(withTransientRetry(read)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured build attempts and fails the build", async () => {
    setBuildPhase(true);
    const read = jest.fn().mockRejectedValue(transient);
    await expect(withTransientRetry(read)).rejects.toThrow(transient);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient error", async () => {
    setBuildPhase(false);
    const read = jest.fn().mockRejectedValue(real);
    await expect(withTransientRetry(read)).rejects.toThrow(real);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
