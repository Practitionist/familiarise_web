import { randomUUID } from "node:crypto";
import v8 from "node:v8";
import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";

// TEMPORARY diagnostic for #1120. Removed before merge. The function log strips
// our own console.* (next.config.mjs compiler.removeConsole) and does not expose
// instance identity, so the only way to read per-instance facts is to return
// them in the response body.
export const dynamic = "force-dynamic";

const INSTANCE_ID = randomUUID().slice(0, 8);
const INSTANCE_BOOTED_AT = Date.now();
let invocations = 0;

export async function GET() {
  const invocation = ++invocations;
  const t0 = Date.now();

  // Event-loop lag: if a 3s pg timer fires at 30s, the loop was stalled.
  let maxLagMs = 0;
  let last = Date.now();
  const probe = setInterval(() => {
    const now = Date.now();
    maxLagMs = Math.max(maxLagMs, now - last - 50);
    last = now;
  }, 50);

  const attempts: Array<{ ms: number; ok: boolean; err?: string }> = [];
  for (let i = 0; i < 3; i++) {
    const s = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      attempts.push({ ms: Date.now() - s, ok: true });
      break;
    } catch (err) {
      attempts.push({
        ms: Date.now() - s,
        ok: false,
        err: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  clearInterval(probe);
  const mem = process.memoryUsage();

  return NextResponse.json(
    {
      instanceId: INSTANCE_ID,
      instanceAgeMs: t0 - INSTANCE_BOOTED_AT,
      invocation,
      totalMs: Date.now() - t0,
      maxLagMs,
      attempts,
      env: {
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
        PG_CONNECT_TIMEOUT_MS: process.env.PG_CONNECT_TIMEOUT_MS ?? null,
        PG_POOL_MAX: process.env.PG_POOL_MAX ?? null,
        NEXT_PHASE: process.env.NEXT_PHASE ?? null,
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE:
          process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? null,
      },
      heapLimitMB: Math.round(
        v8.getHeapStatistics().heap_size_limit / 1024 / 1024,
      ),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
