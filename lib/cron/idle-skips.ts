import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Db } from "@/lib/prisma";
import {
  jobNameFor,
  TARGETS,
  TICK_CLAIM_JOB,
  type Target,
} from "@/lib/cron/schedule";

/**
 * A due target whose idle probe found no work is skipped and listed under this
 * key on the tick's claim row; it writes no run row of its own.
 */
export const IDLE_RESULT_KEY = "idle";

export interface IdleCompletion {
  jobName: string;
  /** The newest tick that skipped the job as idle. */
  endedAt: Date;
  /** Idle skips at or after `countSince`. */
  skips: number;
}

const KNOWN_TARGETS: ReadonlySet<string> = new Set(TARGETS);

function isTarget(name: string): name is Target {
  return KNOWN_TARGETS.has(name);
}

const idleRowSchema = z.object({
  target: z.string(),
  endedAt: z.date(),
  skips: z.number(),
});

/**
 * Idle skips per job from the tick claim rows. An idle skip counts as a
 * finished run that found nothing, so freshness and missed-window checks read it.
 */
export async function readIdleCompletions(
  db: Db,
  environment: string,
  since: Date,
  countSince: Date = since,
): Promise<IdleCompletion[]> {
  const rows = z.array(idleRowSchema).parse(
    await db.$queryRaw(Prisma.sql`
      SELECT idle.target, max(s."endedAt") AS "endedAt",
        (count(*) FILTER (WHERE s."startedAt" >= ${countSince}))::int AS skips
      FROM "SystemJobExecution" s
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(s."result"->(${IDLE_RESULT_KEY}::text)) = 'array'
          THEN s."result"->(${IDLE_RESULT_KEY}::text) ELSE '[]'::jsonb END
      ) AS idle(target)
      WHERE s."jobName" = ${TICK_CLAIM_JOB}
        AND s."startedAt" >= ${since}
        AND s."endedAt" IS NOT NULL
        AND s."result"->>'environment' = ${environment}
      GROUP BY 1`),
  );
  return rows.flatMap((row) =>
    isTarget(row.target)
      ? [
          {
            jobName: jobNameFor(row.target),
            endedAt: row.endedAt,
            skips: row.skips,
          },
        ]
      : [],
  );
}

/** The fresher of a job's last finished run and its last idle skip. */
export function newerOf(
  a: Date | null,
  b: Date | null | undefined,
): Date | null {
  if (!b) return a;
  return !a || b > a ? b : a;
}
