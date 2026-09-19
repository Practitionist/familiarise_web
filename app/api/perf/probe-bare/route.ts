// #1124 — the zero-import arm: nothing from @/lib or @/app, so a stall here is
// the platform's, not this app's module graph.
import { runProbe } from "../_probe";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";

export const dynamic = "force-dynamic";

const moduleLoadedAt = Date.now();

export async function GET() {
  const report = await runProbe(moduleLoadedAt);
  // Diagnostics must never be cached — a cached probe would report a stale
  // instance age and mask the very stalls these routes exist to measure.
  return Response.json(
    { route: "probe-bare", ...report },
    { headers: NO_STORE_HEADERS },
  );
}
