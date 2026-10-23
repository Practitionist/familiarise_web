import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Uses the stored retention deadline; deletion remains explicitly opt-in. */
export async function runConsentRetentionSweeper(
  opts: { limit?: number } = {},
) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  return withCronLock(
    "consent-retention-sweeper",
    { failMode: "closed" },
    async () => {
      const now = new Date();
      const rows = await prisma.consentArtifact.findMany({
        where: { auditRetainedUntil: { lt: now } },
        select: { id: true },
        orderBy: [{ auditRetainedUntil: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const candidates = rows.slice(0, limit);
      const deleteMode = process.env.DPDP_SWEEPER_DELETE === "true";
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
