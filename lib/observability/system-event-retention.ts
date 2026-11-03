import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";

const RETENTION_DAYS = 400;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const idRows = z.array(z.object({ id: z.string() }));

/**
 * Correlation prefixes whose readers look at events of any age: the latest
 * event is current state (wallet freeze, class reliability) or its existence is
 * a once-only guard or an open needs-human item. The newest event per
 * (correlationId, category) under these prefixes is never pruned.
 */
const STATE_BEARING_EVENT_PREFIXES = [
  "wallet-freeze:",
  "class-reliability:",
  "partial-credit:",
  "partial-credit-closed:",
  "held-paid-seat:",
  "orphaned-payment:",
  "orphan-escrow:",
  "double-booking:",
  "double-booking-blocked:",
  "capture-unseated-seat:",
] as const;

function likePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Oldest-first ids past the cutoff, skipping each state-bearing key's newest event. */
function prunableIds(cutoff: Date, take: number): Prisma.Sql {
  const patterns = STATE_BEARING_EVENT_PREFIXES.map(likePattern);
  return Prisma.sql`
    SELECT e."id" FROM "system_events" e
    WHERE e."createdAt" < ${cutoff}
      AND NOT (
        COALESCE(e."correlationId" LIKE ANY (${patterns}::text[]), false)
        AND NOT EXISTS (
          SELECT 1 FROM "system_events" n
          WHERE n."correlationId" = e."correlationId"
            AND n."category" = e."category"
            AND (n."createdAt", n."id") > (e."createdAt", e."id")))
    ORDER BY e."createdAt", e."id"
    LIMIT ${take}`;
}

/** Removes one oldest-first slice under the 400-day policy. */
export async function pruneSystemEvents(
  opts: { limit?: number; startedAt?: number } = {},
) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const outOfTime = startDeadline(opts.startedAt);
  return withCronLock(
    "prune-system-events",
    { failMode: "closed" },
    async () => {
      if (outOfTime())
        return { success: true, examined: 0, pruned: 0, hasMore: true };
      const cutoff = new Date(
        Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const rows = idRows.parse(
        await prisma.$queryRaw(prunableIds(cutoff, limit + 1)),
      );
      const candidates = rows.slice(0, limit);
      if (candidates.length > 0 && outOfTime())
        return {
          success: true,
          examined: candidates.length,
          pruned: 0,
          hasMore: true,
        };
      // The delete re-applies the selection, so a key's newest event survives a concurrent write.
      const pruned =
        candidates.length > 0
          ? await prisma.$executeRaw(Prisma.sql`
              DELETE FROM "system_events" WHERE "id" IN (
                SELECT p."id" FROM (${prunableIds(cutoff, limit)}) p
                WHERE p."id" IN (${Prisma.join(candidates.map((row) => row.id))}))`)
          : 0;
      return {
        success: true,
        examined: candidates.length,
        pruned,
        hasMore: rows.length > limit,
      };
    },
  );
}
