/**
 * @jest-environment node
 */

/**
 * D4 — the recording expiry clock was measured from the wrong instant.
 *
 * `streamUrlExpiresAt = now() + 14d` is right on the webhook path and wrong on
 * the path that wrote the orphan-reconciler's rows. Two clocks run from
 * different instants:
 *
 *   - Stream's retention on the object: fourteen days from the CALL.
 *   - The app-level `cdn_expiration_seconds` on the live Stream app (1209600):
 *     fourteen days from when the URL was MINTED.
 *
 * The bytes die at whichever runs out first. Measuring from `now()` makes a row
 * recovered on day ten (which is exactly what
 * `scripts/stream/reconcile-orphaned-recordings.ts` does when a `recording_ready`
 * delivery was lost) claim an expiry of day 24 while Stream deletes the object
 * on day 14 — and `app/api/stream/recordings/[recordingId]`'s 410 gate only asks
 * whether `streamUrlExpiresAt` has passed, so for ten days it hands the user a
 * URL that 404s. Measuring from `recordedAt` and clamping to `now + 14d` puts
 * the deadline on the earlier of the two, which is the truth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  STREAM_RECORDING_RETENTION_DAYS,
  streamUrlExpiresAt,
} from "@/lib/stream/recording-utils";

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("streamUrlExpiresAt", () => {
  it("is fourteen days, the number Stream's retention and the app both use", () => {
    expect(STREAM_RECORDING_RETENTION_DAYS).toBe(14);
  });

  it("lands on call + 14d for a recording written at ready time", () => {
    const recordedAt = new Date("2026-03-04T10:00:00.000Z");
    const now = new Date("2026-03-04T10:02:00.000Z");

    // The two-minute skew means the CDN expiry is already the binding clock, so
    // the answer is `now + 14d`, not `recordedAt + 14d` — and the difference is
    // the two minutes the URL has genuinely been alive.
    expect(iso(streamUrlExpiresAt(recordedAt, now))).toBe("2026-03-18");
  });

  it("does not push a late recovery past Stream's own deletion", () => {
    const recordedAt = new Date("2026-03-04T10:00:00.000Z");
    // Recovered on day 10 by the orphan reconciler.
    const now = new Date("2026-03-14T09:00:00.000Z");

    const expires = streamUrlExpiresAt(recordedAt, now);

    // call + 14d = 2026-03-18, now + 14d = 2026-03-28. The bytes are gone on
    // the 18th, so the 18th is the answer — the old `now() + 14d` returned the
    // 28th and the 410 gate waved ten days of dead URLs through.
    expect(iso(expires)).toBe("2026-03-18");
    expect(expires.getTime()).toBeLessThanOrEqual(
      recordedAt.getTime() + 14 * DAY,
    );
  });

  it("never reports an expiry in the past for a fresh recording", () => {
    const recordedAt = new Date();
    const expires = streamUrlExpiresAt(recordedAt, new Date());
    expect(expires.getTime()).toBeGreaterThan(Date.now());
  });

  it("is computed in UTC, so the calendar day does not depend on the runtime", () => {
    // 23:30 UTC on the 31st. A local-timezone `setDate` rolls the month on half
    // the fleet, so the same recording would expire on a different day — and a
    // month boundary shifts it by a whole month.
    const recordedAt = new Date("2026-01-31T23:30:00.000Z");
    expect(iso(streamUrlExpiresAt(recordedAt, recordedAt))).toBe("2026-02-14");
  });

  it("survives a leap-day call without landing in March twice", () => {
    const recordedAt = new Date("2028-02-28T12:00:00.000Z");
    expect(iso(streamUrlExpiresAt(recordedAt, recordedAt))).toBe("2028-03-13");
  });
});

describe("the writers that consume it", () => {
  // A source-level guard, because both writers compute the value inline and a
  // refactor that reintroduces `now() + 14d` is invisible to every behavioural
  // test here.
  const read = (rel: string) =>
    readFileSync(join(__dirname, "../../", rel), "utf8");

  const INLINE_14D = /setDate\([^)]*getDate\(\)\s*\+\s*14/;

  it("recording-service no longer computes now() + 14d inline", () => {
    expect(read("lib/stream/recording-service.ts")).not.toMatch(INLINE_14D);
  });

  it("recording-service derives it from the call's start time", () => {
    expect(read("lib/stream/recording-service.ts")).toContain(
      "streamUrlExpiresAt(startDate)",
    );
  });

  // #1829 — the second writer, un-skipped. This test was written and skipped
  // rather than deleted, because `lib/stream/recording-handlers.ts` belonged to
  // another bucket's worktree while this one was being built. It is live now.
  //
  // The value exists in ONE helper for a reason: a webhook-path write and a
  // reconciler-path write computing it two different ways is precisely how a
  // ten-day window appeared in which the 410 gate passed and every viewer got a
  // dead Stream URL. The two writers must not be able to drift again, so the
  // assertion is on the SOURCE, not on a re-implementation of the arithmetic.
  it("recording-handlers derives it from the call's start time too", () => {
    const source = read("lib/stream/recording-handlers.ts");
    expect(source).toContain("streamUrlExpiresAt(startDate)");
    expect(source).not.toMatch(INLINE_14D);
  });

  it("recording-handlers imports the helper rather than redeclaring it", () => {
    // The rename (`expiresAt` for the local, `streamUrlExpiresAt` for the
    // column) exists because the local shadowed the import. Asserting the import
    // catches a future copy-paste that reintroduces the shadow.
    const source = read("lib/stream/recording-handlers.ts");
    expect(source).toMatch(/import\s*\{[^}]*streamUrlExpiresAt[^}]*\}/);
  });

  // D5, the other half of the cross-bucket handoff: the ready-time kick read
  // only the webinar and class arms, so a PERMANENT consultation or
  // subscription plan was never auto-transferred — and was still EXPIRED by the
  // unfiltered mark-expired sweep, which is how a paying customer silently lost
  // storage they had bought.
  it("recording-handlers resolves the storage policy through the one resolver", () => {
    const source = read("lib/stream/recording-handlers.ts");
    expect(source).toContain("resolveAppointmentStoragePolicy(appointment)");
    expect(source).not.toMatch(
      /webinar\?\.webinarPlan\?\.recordingStoragePolicy/,
    );
  });
});
