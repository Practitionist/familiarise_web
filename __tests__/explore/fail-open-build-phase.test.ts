/**
 * The public explore routes are prerendered during `next build`, so a transient
 * pooler timeout there would bake an empty page into static HTML and serve it to
 * every visitor for a whole revalidate window. These helpers must therefore fail
 * OPEN at request time and CLOSED during the build. (#932)
 */
import { PHASE_PRODUCTION_BUILD } from "next/constants";

import {
  emptyOnTransientDbError,
  fallbackOnTransientDbError,
  isTransientDbError,
  withBuildTimeRetry,
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

describe("request phase (fail open)", () => {
  beforeEach(() => setBuildPhase(false));

  it("emptyOnTransientDbError degrades a transient error to []", () => {
    expect(emptyOnTransientDbError("ctx")(transient)).toEqual([]);
  });

  it("fallbackOnTransientDbError degrades a transient error to the fallback", () => {
    expect(fallbackOnTransientDbError("ctx", { total: 0 })(transient)).toEqual({
      total: 0,
    });
  });

  it("still rethrows non-transient errors", () => {
    expect(() => emptyOnTransientDbError("ctx")(real)).toThrow(real);
    expect(() => fallbackOnTransientDbError("ctx", null)(real)).toThrow(real);
  });
});

describe("production build phase (fail closed)", () => {
  beforeEach(() => setBuildPhase(true));

  it("emptyOnTransientDbError rethrows rather than baking an empty page", () => {
    expect(() => emptyOnTransientDbError("ctx")(transient)).toThrow(transient);
  });

  it("fallbackOnTransientDbError rethrows rather than baking a fallback page", () => {
    expect(() => fallbackOnTransientDbError("ctx", null)(transient)).toThrow(
      transient,
    );
  });
});

describe("withBuildTimeRetry", () => {
  it("does not retry at request time — one attempt, error propagates", async () => {
    setBuildPhase(false);
    const read = jest.fn().mockRejectedValue(transient);
    await expect(withBuildTimeRetry(read)).rejects.toThrow(transient);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure during the build and succeeds", async () => {
    setBuildPhase(true);
    const read = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ok");
    await expect(withBuildTimeRetry(read)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts and fails the build", async () => {
    setBuildPhase(true);
    const read = jest.fn().mockRejectedValue(transient);
    await expect(withBuildTimeRetry(read)).rejects.toThrow(transient);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient error during the build", async () => {
    setBuildPhase(true);
    const read = jest.fn().mockRejectedValue(real);
    await expect(withBuildTimeRetry(read)).rejects.toThrow(real);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
