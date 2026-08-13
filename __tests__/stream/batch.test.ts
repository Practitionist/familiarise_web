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

import {
  chunk,
  forEachChunk,
  STREAM_BATCH_LIMIT,
  STREAM_CONCURRENCY_LIMIT,
} from "@/lib/stream/batch";

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

describe("payload ceiling vs fan-out width", () => {
  it("keeps them as separate constants", () => {
    // They answer different questions and only coincidentally started the same.
    // STREAM_BATCH_LIMIT is how many items fit in ONE request (upsertUsers,
    // addMembers, deleteChannels). STREAM_CONCURRENCY_LIMIT is how many separate
    // requests to have in flight for operations Stream gives no bulk endpoint
    // for — freezing a channel being the one that bit.
    expect(STREAM_CONCURRENCY_LIMIT).toBeLessThan(STREAM_BATCH_LIMIT);
    expect(Number.isInteger(STREAM_CONCURRENCY_LIMIT)).toBe(true);
    expect(STREAM_CONCURRENCY_LIMIT).toBeGreaterThan(0);
  });

  it("rejects a non-integer chunk size instead of silently misbehaving", () => {
    // `items.slice(i, i + 2.5)` does not throw; it produces uneven chunks and a
    // caller that thinks it bounded a payload has not.
    expect(() => chunk([1, 2, 3], 2.5)).toThrow(/positive integer/);
    expect(() => chunk([1, 2, 3], 0)).toThrow(/positive integer/);
    expect(() => chunk([1, 2, 3], -1)).toThrow(/positive integer/);
  });
});
