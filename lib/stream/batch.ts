/**
 * #1134 P1-20 — Stream's per-request ceilings, in one place.
 *
 * Every bulk call in this codebase passed the whole array straight through:
 * `upsertUsers(allMembers)` and `channel.create({ members: allMembers })` with
 * no slicing anywhere. `WebinarPlan.maxParticipants` defaults to 100 and
 * `Webinar.maxParticipants` is unbounded, so a lazy channel create for a large
 * webinar sent an oversized request, threw, and landed in a catch that (before
 * #1136) did not even reach Sentry — the attendee silently got no chat.
 *
 * Stream documents 100 as the limit for all three of the calls we make:
 *   upsertUsers            — 100 users per request
 *   addMembers/removeMembers — 100 members per request
 *   deleteChannels         — 100 channels per request
 */
export const STREAM_BATCH_LIMIT = 100;

/**
 * Fan-out width for operations Stream gives us NO bulk endpoint for.
 *
 * Deliberately separate from `STREAM_BATCH_LIMIT`, which is a PAYLOAD ceiling —
 * how many items fit inside one request. Freezing a channel has no bulk form, so
 * it is one request per channel; chunking those by 100 and awaiting the chunk
 * fires a hundred simultaneous requests, which is precisely the shape the note
 * on `forEachChunk` below warns about. The two numbers answer different
 * questions and only coincidentally started out the same.
 *
 * Ten is a conservative fan-out rather than a figure derived from a published
 * per-second quota; Stream documents the per-request ceilings above but not a
 * concurrency limit we can point at. Being wrong low costs a slower background
 * job, being wrong high costs 429s on live user traffic sharing the app.
 */
export const STREAM_CONCURRENCY_LIMIT = 10;

/** Split into chunks of at most `size`. Empty input yields no chunks. */
export function chunk<T>(items: T[], size: number = STREAM_BATCH_LIMIT): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run `fn` over each chunk in sequence.
 *
 * Sequential on purpose: Stream rate-limits per app, so firing twenty chunks
 * concurrently to shave latency off one webinar create is how you 429 every
 * other request in flight. These paths are all background or one-off.
 */
export async function forEachChunk<T>(
  items: T[],
  fn: (batch: T[], index: number) => Promise<void>,
  size: number = STREAM_BATCH_LIMIT,
): Promise<void> {
  const batches = chunk(items, size);
  for (let i = 0; i < batches.length; i++) {
    await fn(batches[i], i);
  }
}
