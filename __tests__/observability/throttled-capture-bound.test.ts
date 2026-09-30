/**
 * @jest-environment node
 */

/**
 * #E6 — `captureThrottled`'s map was unbounded and keyed on a caller-supplied
 * string.
 *
 * That combination turns a throttle into a leak. The map is meant to collapse
 * repeats of one underlying fact; an unbounded map lets it quietly become a
 * per-id firehose instead, which is the exact flood the module exists to
 * prevent — several call sites build their key from an id or a value
 * (`stream-health:webhook-secret:<reason>`, the Upstash usage probe key), so the
 * keyspace grows with the number of distinct VALUES rather than the number of
 * distinct failure CLASSES.
 *
 * On a serverless instance the damage is bounded by the ~5 min reclaim, so it is
 * mostly theoretical. It is fixed anyway because the cron entry points run in a
 * LONG-LIVED Node process — `runJobWithSentry` wraps a bare `tsx` job that can
 * run 35 minutes against the 100k-user walk — and "mostly harmless here" is
 * exactly how the next caller ends up using it in a worker.
 *
 * Eviction is oldest-first on INSERT. The oldest key is the one whose window has
 * most likely already expired, so a later report of that class re-fires once:
 * a duplicate event, never a lost one. The direction is the whole design.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as Sentry from "@sentry/nextjs";
import {
  captureThrottled,
  resetThrottledCaptureForTesting,
  throttleKeyCountForTesting,
} from "../../lib/observability/throttled-capture";

const SUBSYSTEM = { subsystem: "test" } as const;

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
});

describe("captureThrottled — the bound (#E6)", () => {
  it("still collapses repeats of one key inside the window", () => {
    // The behaviour being protected. If this ever fails, the fix has cost the
    // module its reason to exist.
    expect(captureThrottled("a", new Error("x"), SUBSYSTEM)).toBe(true);
    expect(captureThrottled("a", new Error("x"), SUBSYSTEM)).toBe(false);
    expect(captureThrottled("b", new Error("x"), SUBSYSTEM)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct subsystems on separate windows", () => {
    // A per-key rather than a global timestamp: an outage in one subsystem must
    // not consume the window another subsystem needs.
    captureThrottled("a", new Error("x"), SUBSYSTEM);
    captureThrottled("b", new Error("x"), SUBSYSTEM);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it("holds a bounded number of keys however many distinct keys arrive", () => {
    // The leak. A thousand distinct keys — which is what a caller keying on an
    // id produces — must not leave a thousand entries behind.
    for (let i = 0; i < 1_000; i++) {
      captureThrottled(`probe:${i}`, new Error("x"), SUBSYSTEM);
    }

    // Far above the real number of failure classes in this codebase, far below
    // anything that would matter for memory.
    expect(throttleKeyCountForTesting()).toBeLessThanOrEqual(512);
  });

  it("evicts the OLDEST key, so a re-report of it fires rather than being lost", () => {
    // Fill past the ceiling so the very first key is the eviction victim, then
    // report it again. A duplicate is acceptable; silence is not — the whole
    // point of a ceiling alarm is that something is eventually reported.
    captureThrottled("oldest", new Error("x"), SUBSYSTEM);
    for (let i = 0; i < 600; i++) {
      captureThrottled(`filler:${i}`, new Error("x"), SUBSYSTEM);
    }
    (Sentry.captureException as jest.Mock).mockClear();

    expect(captureThrottled("oldest", new Error("x"), SUBSYSTEM)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not evict a key to make room for a key that already exists", () => {
    // Insertion-order eviction must not become "the busiest class loses its
    // throttle", which would restore the firehose for the class that matters
    // most. A re-report of an existing key is a no-op on the map's size — it
    // cannot be the reason a different key's window is thrown away.
    for (let i = 0; i < 512; i++) {
      captureThrottled(`filler:${i}`, new Error("x"), SUBSYSTEM);
    }
    const sizeAtCeiling = throttleKeyCountForTesting();
    expect(sizeAtCeiling).toBe(512);

    // `filler:511` is the newest, so it is definitely still present.
    expect(captureThrottled("filler:511", new Error("x"), SUBSYSTEM)).toBe(
      false,
    );
    expect(throttleKeyCountForTesting()).toBe(sizeAtCeiling);
  });
});
