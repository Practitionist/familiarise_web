/**
 * @jest-environment node
 */

/**
 * #1134 P1-20 — Stream caps `upsertUsers`, `addMembers`/`removeMembers` and
 * `deleteChannels` at 100 per request. Every bulk call in this codebase passed
 * the whole array straight through, so a webinar roster above 100 (the plan
 * default, and `Webinar.maxParticipants` is unbounded) produced an oversized
 * request that threw into a catch which did not even reach Sentry — the
 * attendee silently got no chat.
 */

import { chunk, forEachChunk, STREAM_BATCH_LIMIT } from "@/lib/stream/batch";

describe("chunk", () => {
  it("defaults to Stream's documented ceiling", () => {
    expect(STREAM_BATCH_LIMIT).toBe(100);
    const batches = chunk(Array.from({ length: 250 }, (_, i) => i));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("never emits an oversized batch, at any input size", () => {
    for (const n of [1, 99, 100, 101, 199, 200, 201, 1000]) {
      const batches = chunk(Array.from({ length: n }, (_, i) => i));
      expect(batches.every((b) => b.length <= STREAM_BATCH_LIMIT)).toBe(true);
      expect(batches.flat()).toHaveLength(n);
    }
  });

  it("loses nothing and preserves order", () => {
    const input = Array.from({ length: 137 }, (_, i) => `u${i}`);
    expect(chunk(input, 25).flat()).toEqual(input);
  });

  it("yields no batches for an empty list", () => {
    // The callers must not fire a request with an empty member array.
    expect(chunk([])).toEqual([]);
  });

  it("rejects a nonsense size rather than looping forever", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});

describe("forEachChunk", () => {
  it("runs batches sequentially", async () => {
    // Sequential on purpose: Stream rate-limits per app, so firing twenty
    // chunks at once to shave latency off one webinar create is how you 429
    // every other request in flight.
    const order: string[] = [];
    await forEachChunk(
      Array.from({ length: 30 }, (_, i) => i),
      async (batch, index) => {
        order.push(`start:${index}`);
        await new Promise((r) => setTimeout(r, 1));
        order.push(`end:${index}`);
        expect(batch.length).toBeLessThanOrEqual(10);
      },
      10,
    );
    expect(order).toEqual([
      "start:0",
      "end:0",
      "start:1",
      "end:1",
      "start:2",
      "end:2",
    ]);
  });

  it("does not invoke the callback for an empty list", async () => {
    const fn = jest.fn();
    await forEachChunk([], fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates a failure rather than silently skipping the rest", async () => {
    const seen: number[] = [];
    await expect(
      forEachChunk(
        [1, 2, 3, 4],
        async (batch, index) => {
          seen.push(index);
          if (index === 1) throw new Error("stream 429");
        },
        2,
      ),
    ).rejects.toThrow("stream 429");
    // Stopped at the failure; the caller decides whether to retry.
    expect(seen).toEqual([0, 1]);
  });
});
