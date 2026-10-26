import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";

const RETENTION_DAYS = 400;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Removes one oldest-first slice under the existing 400-day policy. */
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
      const rows = await prisma.systemEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const candidates = rows.slice(0, limit);
      if (candidates.length > 0 && outOfTime())
        return {
          success: true,
          examined: candidates.length,
          pruned: 0,
          hasMore: true,
        };
      const pruned =
        candidates.length > 0
          ? (
              await prisma.systemEvent.deleteMany({
                where: {
                  id: { in: candidates.map((row) => row.id) },
                  createdAt: { lt: cutoff },
                },
              })
            ).count
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
