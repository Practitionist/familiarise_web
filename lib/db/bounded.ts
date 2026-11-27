/**
 * Bounded concurrency for reads on the serverless pool. With PG_POOL_MAX=1
 * every extra query queues behind the one connection, and PG_CONNECT_TIMEOUT_MS
 * (3 s) applies to that queue wait, so a wide Promise.all can time out before
 * it starts. Callers cap reads in flight: 1 when the pool is 1 (a second read
 * cannot start sooner on one connection, it only spends its own wait), else 6.
 */
export function poolLimit(): number {
  const max = Number(process.env.PG_POOL_MAX);
  return Number.isFinite(max) && max <= 1 ? 1 : 6;
}

/** `items.map(fn)` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length))
    .fill(null)
    .map(async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    });
  await Promise.all(workers);
  return out;
}

/** Runs independent zero-argument reads through `mapLimit(poolLimit())`. */
export function runBounded<T extends readonly (() => Promise<unknown>)[]>(
  tasks: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  return mapLimit(tasks, poolLimit(), (run) => run()) as Promise<{
    [K in keyof T]: Awaited<ReturnType<T[K]>>;
  }>;
}
