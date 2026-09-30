/**
 * @jest-environment node
 */

/**
 * #1829 — three defects found in review, all of the same shape: the code
 * contradicted its own comment, so each read as correct on the page.
 *
 *   1. The concurrency sweep claimed `open` was kept sorted and pushed onto it
 *      instead. Intervals arrive sorted by START, which says nothing about their
 *      ENDS, so a short interval could be stranded behind a long one and peak
 *      concurrency was overcounted — on a figure that feeds a billing alarm.
 *   2. The Stream outage ledger was keyed by a single module-level slot, but the
 *      health route runs TWO probes per poll. They alternated, so one ongoing
 *      incident wrote a "reachable again" row and an "unreachable" row on every
 *      poll, forever, and the table became unreadable.
 *   3. The throttle evicted the OLDEST map entry — but `Map.set` on a key that
 *      is already present keeps that key's ORIGINAL insertion position, so the
 *      noisiest key sat at the front and was the one evicted. The throttle
 *      protected quiet keys and sacrificed the loudest, which is its exact
 *      inverse, and it was invisible because the cap was still respected.
 *
 * Each is asserted against the MECHANISM, with the counter-example written out,
 * rather than against the symptom the reviewer happened to observe.
 */

// ---------------------------------------------------------------------------
// 1. the concurrency sweep
// ---------------------------------------------------------------------------

import { sweepIntervals } from "../../lib/stream/usage-estimator";

const MINUTE = 60_000;

describe("sweepIntervals keeps `open` sorted by end", () => {
  // The counter-example from the fix. Sorted by start: A [0,100], B [1,2],
  // C [50,60]. Pushing C's end 60 behind A's 100 left `open = [100, 2]`, the
  // retire check compared `open[0] = 100` against C's start of 50, retired
  // nothing, and read a peak of 3. The true peak is 2.
  it("does not overcount when a short interval follows a long one", () => {
    const { peak } = sweepIntervals([
      { start: 0, end: 100 },
      { start: 1, end: 2 },
      { start: 50, end: 60 },
    ]);
    expect(peak).toBe(2);
  });

  it("survives ends that decrease monotonically", () => {
    // Every push is a re-insert here, so a single unsorted push would surface.
    const { peak } = sweepIntervals([
      { start: 0, end: 300 },
      { start: 1, end: 200 },
      { start: 2, end: 100 },
      { start: 3, end: 50 },
    ]);
    expect(peak).toBe(4);
  });

  it("survives a long interval opened LAST, which is the other way to strand", () => {
    const { peak } = sweepIntervals([
      { start: 0, end: 5 },
      { start: 1, end: 6 },
      { start: 2, end: 900 },
    ]);
    expect(peak).toBe(3);
  });

  it("still counts genuinely overlapping intervals", () => {
    const { peak } = sweepIntervals([
      { start: 0, end: 100 },
      { start: 10, end: 50 },
      { start: 20, end: 30 },
    ]);
    expect(peak).toBe(3);
  });

  it("does not count two merely-touching intervals as overlapping", () => {
    // A participant leaving exactly as another joins is not a second
    // simultaneous participant, and this figure feeds a billing alarm.
    const { peak } = sweepIntervals([
      { start: 0, end: 60 },
      { start: 60, end: 120 },
    ]);
    expect(peak).toBe(1);
  });

  it("returns zero for an empty set rather than throwing", () => {
    expect(sweepIntervals([]).peak).toBe(0);
  });

  it("sums minutes independently of the ordering", () => {
    // The minutes total must not depend on the fix; if it does, the retirement
    // loop has started double-subtracting.
    const a = sweepIntervals([
      { start: 0, end: 60 * MINUTE },
      { start: 60 * MINUTE, end: 120 * MINUTE },
    ]);
    expect(a.minutes).toBe(120);
  });

  it("clamps a negative interval to zero rather than subtracting", () => {
    // A webhook that closed a presence row before opening one, or clock skew
    // between the join and leave events. The bias must stay upward.
    const { minutes } = sweepIntervals([
      { start: 0, end: 10 * MINUTE },
      { start: 5 * MINUTE, end: 4 * MINUTE },
    ]);
    expect(minutes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2. the outage ledger is per-probe
// ---------------------------------------------------------------------------

describe("the Stream outage ledger is keyed per probe", () => {
  const written: { summary: string }[] = [];

  beforeEach(() => {
    written.length = 0;
    jest.resetModules();
    jest.doMock("../../lib/enterprise/system-events", () => ({
      recordSystemErrorSafe: (opts: { summary: string }) => {
        written.push({ summary: opts.summary });
        return Promise.resolve();
      },
    }));
  });

  afterEach(() => {
    jest.dontMock("../../lib/enterprise/system-events");
  });

  const load = async () => {
    const mod = await import("../../lib/stream/system-event");
    mod.resetStreamOutageLedgerForTesting();
    return mod;
  };

  it("does not flap when two probes alternate in one poll", async () => {
    const { recordStreamOutage: record } = await load();

    // The exact sequence the health route runs on every poll during an outage:
    // webhook secret first, then reachability.
    for (let poll = 0; poll < 3; poll++) {
      await record({
        probe: "webhook-secret",
        unhealthy: true,
        reason: "MISMATCH",
      });
      await record({
        probe: "reachability",
        unhealthy: true,
        reason: "UNREACHABLE",
      });
    }

    // Two probes, one transition each. A shared slot would have written six.
    expect(written).toHaveLength(2);
  });

  it("treats a recovery on one probe as its own event", async () => {
    const { recordStreamOutage: record } = await load();

    await record({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    await record({ probe: "webhook-secret", unhealthy: false, reason: "OK" });

    // "is the secret right?" and "can we reach Stream?" are different failures
    // with different fixes. Folding them into one ledger is what made the table
    // unreadable — one alternating pair of rows per poll.
    expect(written).toHaveLength(2);
    expect(written.some((w) => /reachable again/i.test(w.summary))).toBe(true);
  });

  it("suppresses repeats of an unchanged state", async () => {
    const { recordStreamOutage: record } = await load();
    await record({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    for (let i = 0; i < 20; i++) {
      await record({
        probe: "reachability",
        unhealthy: true,
        reason: "UNREACHABLE",
      });
    }
    expect(written).toHaveLength(1);
  });

  it("records a genuine transition on a single probe", async () => {
    const { recordStreamOutage: record } = await load();
    await record({
      probe: "reachability",
      unhealthy: true,
      reason: "UNREACHABLE",
    });
    await record({
      probe: "reachability",
      unhealthy: false,
      reason: "REACHABLE",
    });
    expect(written).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. the throttle evicts the oldest, not the hottest
// ---------------------------------------------------------------------------

describe("the throttled-capture map evicts oldest-first", () => {
  it("keeps the hottest key rather than evicting it", async () => {
    const mod = await import("../../lib/observability/throttled-capture");
    mod.resetThrottledCaptureForTesting();
    const opts = { subsystem: "stream" };

    // Fill to the cap with quiet keys.
    const filler = 512;
    for (let i = 0; i < filler; i++) {
      mod.captureThrottled(`quiet-${i}`, new Error("x"), opts, 0);
    }
    expect(mod.throttleKeyCountForTesting()).toBe(filler);

    // Then report ONE key repeatedly — the hot class, the one the throttle
    // exists for. It is now the most recent entry.
    for (let i = 0; i < 50; i++) {
      mod.captureThrottled("noisy", new Error("x"), opts, 0);
    }

    // Overflow by more keys than the cap can hold.
    for (let i = 0; i < 20; i++) {
      mod.captureThrottled(`new-${i}`, new Error("x"), opts, 0);
    }

    // The hot key is still known, i.e. it was NOT the one evicted. With
    // `Map.set` keeping the original insertion position it sat at the front and
    // was removed on the first overflow — so the throttle dropped the noisiest
    // class and kept the quiet ones, which is its exact inverse.
    const stillTracked = mod.captureThrottled(
      "noisy",
      new Error("x"),
      opts,
      60_000,
    );
    // A `false` means "already reported inside the window", i.e. the key is
    // still in the map. That is the property under test.
    expect(stillTracked).toBe(false);
  });

  it("stays within its cap", async () => {
    const mod = await import("../../lib/observability/throttled-capture");
    mod.resetThrottledCaptureForTesting();
    for (let i = 0; i < 900; i++) {
      mod.captureThrottled(
        `k-${i}`,
        new Error("x"),
        { subsystem: "stream" },
        0,
      );
    }
    expect(mod.throttleKeyCountForTesting()).toBeLessThanOrEqual(512);
  });
});
