import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import { jobEnvironment } from "@/lib/cron/run-outcome";
import { TICK_CLAIM_JOB } from "@/lib/cron/schedule";
import { isUniqueViolation } from "@/lib/db/pg-errors";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };

const claimSchema = z.object({
  tickId: z.string().uuid(),
  slot: z.string().datetime(),
});

/**
 * Claims one five-minute ticker slot. The tick id is derived from the slot and
 * is the row's primary key, so a second dispatch of the same slot gets `false`.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
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
  const { tickId, slot } = parsed.data;
  try {
    const { default: prisma } = await import("@/lib/prisma");
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
        },
      },
      select: { id: true },
    });
    return NextResponse.json({ claimed: true }, { headers: HEADERS });
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
