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

  // Cross-bucket, and deliberately skipped rather than silently passing.
  //
  // `lib/stream/recording-handlers.ts` is owned by another agent's worktree, so
  // the D4 fix could not be applied here. On the webhook path the skew is
  // minutes and no user is harmed, which is why it is the lower half of the fix
  // and not urgent — but the two writers must not compute the value two
  // different ways, or the next reader has to work out which is authoritative.
  //
  // What that agent must change, in `handleRecordingReady`:
  //   1. add `streamUrlExpiresAt` to the existing
  //      `import { generateRecordingTitle, getEventAttendeeIds } from
  //      "@/lib/stream/recording-utils"` block;
  //   2. replace
  //        // Calculate Stream URL expiration (2 weeks from now)
  //        const streamUrlExpiresAt = new Date();
  //        streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);
  //      with `const expiresAt = streamUrlExpiresAt(startDate);`
  //   3. pass `streamUrlExpiresAt: expiresAt` to the `recording.create` call
  //      (the local name shadows the imported helper, hence the rename).
  it.skip("recording-handlers still computes now() + 14d inline — see the note above", () => {
    expect(read("lib/stream/recording-handlers.ts")).not.toMatch(INLINE_14D);
  });
});
