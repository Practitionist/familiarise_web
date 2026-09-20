/**
 * Keep-warm — Netlify support ticket #1112198 (2026-09-16/17): a burst of new
 * server-handler instances stalls ~28 s in Netlify's shared regional pool,
 * no plan offers a warm floor, and execution environments are reclaimed after
 * ~5 minutes idle, so a five-minute ping races the reclaim. This function runs
 * every four minutes and fires N PARALLEL pings (one warm instance serves one
 * request) at the zero-import probe route, awaited briefly: reaching the edge
 * is what retains the instance. KEEP_WARM_CONCURRENCY=0 disables it; env
 * changes need a redeploy. Separate from cron-tick so the sweeps keep their
 * own cadence (ADR 27).
 */

export const config = { schedule: "*/4 * * * *" };

export const KEEP_WARM_PATH = "/api/perf/probe-bare";
const KEEP_WARM_TIMEOUT_MS = 4_000;

/** How many instances to keep warm; defaults to 5 (Netlify's suggested 3–5, top end). */
export function keepWarmConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 5;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : 5;
}

/** One unique-key URL per ping so no cache and no coalescing answers them. */
export function keepWarmUrls(baseUrl: string, n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `${baseUrl}${KEEP_WARM_PATH}?k=${Date.now().toString(36)}-${i}`,
  );
}

async function ping(url: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEEP_WARM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status;
  } catch {
    // A stalled instance answers after our abort; the ping still retained it.
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

export default async function keepWarm(_req: Request): Promise<Response> {
  let baseUrl = process.env.CRON_TICK_BASE_URL || process.env.URL || "";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const n = keepWarmConcurrency(process.env.KEEP_WARM_CONCURRENCY);
  const started = Date.now();
  const statuses =
    n === 0 ? [] : await Promise.all(keepWarmUrls(baseUrl, n).map(ping));
  const body = {
    event: "keep-warm",
    warmed: n,
    answered: statuses.filter((s) => s === 200).length,
    durationMs: Date.now() - started,
  };
  console.log(JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
