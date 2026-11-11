import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import { IDLE_RESULT_KEY } from "@/lib/cron/idle-skips";
import { jobEnvironment } from "@/lib/cron/run-outcome";
import { TARGETS, TICK_CLAIM_JOB } from "@/lib/cron/schedule";
import { isUniqueViolation } from "@/lib/db/pg-errors";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };
const KNOWN_TARGETS: ReadonlySet<string> = new Set(TARGETS);

const claimSchema = z.object({
  tickId: z.string().uuid(),
  slot: z.string().datetime(),
  due: z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? "").split(",").filter((name) => KNOWN_TARGETS.has(name)),
    ),
});

/**
 * Claims one five-minute ticker slot and probes its due targets for work. The
 * tick id is the row's primary key, so a second dispatch of the same slot gets
 * `false`; `idle` lists the targets to skip, recorded on the claim row first,
 * and `pendingAges` carries the queue gauges the ticker puts on its summary.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: HEADERS },
    );
  }
  const parsed = claimSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_TICK_CLAIM" },
      { status: 400, headers: HEADERS },
    );
  }
  const { tickId, slot, due } = parsed.data;
  try {
    const { default: prisma } = await import("@/lib/prisma");
    // A probe that cannot run skips nothing; the slot is still claimed.
    const { idle, pendingAges } = await import("@/lib/cron/idle-probe")
      .then(({ probeTick }) => probeTick(due, prisma))
      .catch(() => ({ idle: [], pendingAges: null }));
    const now = new Date();
    await prisma.systemJobExecution.create({
      data: {
        id: tickId,
        jobId: TICK_CLAIM_JOB,
        jobName: TICK_CLAIM_JOB,
        status: "COMPLETED",
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        triggeredBy: "cron",
        result: {
          outcome: "completed",
          reason: "tick-claim",
          environment: jobEnvironment(),
          tickId,
          slot,
          [IDLE_RESULT_KEY]: idle,
          idleCount: idle.length,
        },
      },
      select: { id: true },
    });
    return NextResponse.json(
      { claimed: true, idle, ...(pendingAges ? { pendingAges } : {}) },
      { headers: HEADERS },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ claimed: false }, { headers: HEADERS });
    }
    return NextResponse.json(
      { error: "TICK_CLAIM_UNAVAILABLE" },
      { status: 503, headers: HEADERS },
    );
  }
}
