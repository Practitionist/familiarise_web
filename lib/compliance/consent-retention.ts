import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Uses the stored retention deadline; deletion remains explicitly opt-in. */
export async function runConsentRetentionSweeper(
  opts: { limit?: number; startedAt?: number } = {},
) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const outOfTime = startDeadline(opts.startedAt);
  const deleteMode = process.env.DPDP_SWEEPER_DELETE === "true";
  return withCronLock(
    "consent-retention-sweeper",
    { failMode: "closed" },
    async () => {
      if (outOfTime())
        return {
          success: true,
          expiredSampled: 0,
          deleted: 0,
          deleteMode,
          hasMore: true,
        };
      const now = new Date();
      const rows = await prisma.consentArtifact.findMany({
        where: { auditRetainedUntil: { lt: now } },
        select: { id: true },
        orderBy: [{ auditRetainedUntil: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const candidates = rows.slice(0, limit);
      if (deleteMode && candidates.length > 0 && outOfTime())
        return {
          success: true,
          expiredSampled: rows.length,
          deleted: 0,
          deleteMode,
          hasMore: true,
        };
      const deleted =
        deleteMode && candidates.length > 0
          ? (
              await prisma.consentArtifact.deleteMany({
                where: {
                  id: { in: candidates.map((row) => row.id) },
                  auditRetainedUntil: { lt: now },
                },
              })
            ).count
          : 0;
      return {
        success: true,
        expiredSampled: rows.length,
        deleted,
        deleteMode,
        hasMore: rows.length > limit,
      };
    },
  );
}
