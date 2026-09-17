/**
 * Idempotency-Key lifecycle for allocation attempts. A retry of the SAME
 * payload must reuse the key (the server replays the original batch, #837);
 * any change to mode, event, or slots must mint a fresh key.
 */

import "./setup";

import {
  computeAttemptFingerprint,
  fingerprintGuards,
  resolveAttemptKey,
} from "@/hooks/scheduling/useScheduling";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import { makeConsecutiveTimeSlots } from "./__mocks__/booking.mockData";
import type { CalendarInterval } from "@/lib/scheduling/calendarUtils";

const slots = makeConsecutiveTimeSlots(
  "2026-08-03T09:00:00.000Z",
  2,
) as CalendarInterval[];

describe("computeAttemptFingerprint", () => {
  it("is stable regardless of slot order", () => {
    const reversed = [...slots].reverse();
    expect(computeAttemptFingerprint("manual", "e1", slots)).toBe(
      computeAttemptFingerprint("manual", "e1", reversed),
    );
  });

  it("differs across modes, events, and slot sets", () => {
    const fp = computeAttemptFingerprint("manual", "e1", slots);
    expect(computeAttemptFingerprint("auto", "e1", slots)).not.toBe(fp);
    expect(computeAttemptFingerprint("manual", "e2", slots)).not.toBe(fp);
    expect(
      computeAttemptFingerprint(
        "manual",
        "e1",
        makeConsecutiveTimeSlots(
          "2026-08-04T09:00:00.000Z",
          2,
        ) as CalendarInterval[],
      ),
    ).not.toBe(fp);
  });
});

describe("resolveAttemptKey", () => {
  it("reuses the key for an identical retry", () => {
    const fp = computeAttemptFingerprint("manual", "e1", slots);
    const first = resolveAttemptKey(null, fp);
    const retry = resolveAttemptKey(first, fp);
    expect(retry.key).toBe(first.key);
  });

  it("mints a new key when the payload changes", () => {
    const first = resolveAttemptKey(
      null,
      computeAttemptFingerprint("manual", "e1", slots),
    );
    const changed = resolveAttemptKey(
      first,
      computeAttemptFingerprint("manual", "e1", [
        ...slots,
        ...(makeConsecutiveTimeSlots(
          "2026-08-05T09:00:00.000Z",
          2,
        ) as CalendarInterval[]),
      ]),
    );
    expect(changed.key).not.toBe(first.key);
  });

  it("mints a new key when the mode changes", () => {
    const manual = resolveAttemptKey(
      null,
      computeAttemptFingerprint("manual", "e1", slots),
    );
    const auto = resolveAttemptKey(
      manual,
      computeAttemptFingerprint("auto", "e1", []),
    );
    expect(auto.key).not.toBe(manual.key);
  });

  it("keys look like UUIDs", () => {
    const attempt = resolveAttemptKey(
      null,
      computeAttemptFingerprint("auto", "e1", []),
    );
    expect(attempt.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("differs across allocation intents (#1206 allowPartial)", () => {
    // A partial-success batch stamped under one key must never replay as the
    // answer to a full-intent retry: same mode, same event, same (empty, for
    // auto) slot list — different intent, different key.
    const full = computeAttemptFingerprint("auto", "e1", []);
    const partial = computeAttemptFingerprint("auto", "e1", [], "partial");
    expect(partial).not.toBe(full);
  });

  it("defaults to the full intent when omitted (backwards compatible)", () => {
    expect(computeAttemptFingerprint("auto", "e1", [])).toBe(
      computeAttemptFingerprint("auto", "e1", [], undefined),
    );
  });

  it("differs when stale-tab guards change (#1012)", () => {
    // Same mode, same event, same slots — but a changed reschedule
    // precondition must mint a fresh key, or the server would replay the old
    // batch and mask the 409 the guard should have raised.
    const plain = computeAttemptFingerprint("manual", "e1", slots);
    const guarded = computeAttemptFingerprint(
      "manual",
      "e1",
      slots,
      undefined,
      fingerprintGuards({ expectedTentativeSlotCount: 2 }),
    );
    expect(guarded).not.toBe(plain);
    const changedGuard = computeAttemptFingerprint(
      "manual",
      "e1",
      slots,
      undefined,
      fingerprintGuards({ expectedTentativeSlotCount: 3 }),
    );
    expect(changedGuard).not.toBe(guarded);
    const initial = computeAttemptFingerprint(
      "manual",
      "e1",
      slots,
      undefined,
      fingerprintGuards({ initialAllocation: true }),
    );
    expect(initial).not.toBe(plain);
  });

  it("reuses the key when guards are absent on both attempts", () => {
    expect(fingerprintGuards({})).toBeUndefined();
    expect(
      computeAttemptFingerprint(
        "requested",
        "e1",
        slots,
        undefined,
        fingerprintGuards({}),
      ),
    ).toBe(computeAttemptFingerprint("requested", "e1", slots));
  });

  it("differs when the override intent changes", () => {
    // Skipping the availability-window check changes what the server accepts
    // for identical slots, so it separates keys like any other intent.
    const plain = computeAttemptFingerprint("manual", "e1", slots);
    const overriding = computeAttemptFingerprint(
      "manual",
      "e1",
      slots,
      undefined,
      fingerprintGuards({ override: true }),
    );
    expect(overriding).not.toBe(plain);
    expect(fingerprintGuards({ override: false })).toBeUndefined();
  });
});
