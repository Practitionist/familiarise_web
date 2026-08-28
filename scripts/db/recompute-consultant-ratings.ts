/**
 * #705 — recompute every consultant's rating aggregates once, after the push
 * that adds `publishedRating`, `ratingUnitCount` and `reviewCount`.
 *
 * NOT a backfill migration. It is ordinary application code calling the same
 * `recomputeConsultantRating` every review mutation calls, it is idempotent,
 * it is re-runnable, it touches no DDL, and nothing in the schema depends on it
 * having run. What it prevents is a visible gap: those columns arrive NULL/0,
 * and NULL means "suppressed", so until this runs every consultant's public
 * score is hidden.
 *
 * Serializable + retry per profile, matching the mutation paths — a review
 * landing mid-run must not lose-update the average this writes.
 *
 * Usage: `npx tsx -r dotenv/config scripts/db/recompute-consultant-ratings.ts`
 *        add `--dry-run` to report what would change without writing.
 */
import { Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import { recomputeConsultantRating } from "../../lib/reviews";
import { withSerializableRetry } from "../../lib/db/serializable-retry";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const profiles = await prisma.consultantProfile.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  let done = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id } of profiles) {
    if (dryRun) {
      done += 1;
      continue;
    }
    try {
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => recomputeConsultantRating(tx, id),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      done += 1;
    } catch (error) {
      // One bad profile must not abandon the other eighty-two: a partial run
      // that reports which rows are still stale is far more useful than a
      // crash that leaves you guessing.
      failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(
    JSON.stringify({
      event: dryRun ? "rating_recompute_dry_run" : "rating_recompute_complete",
      profiles: profiles.length,
      recomputed: done,
      failed,
      timestamp: new Date().toISOString(),
    }),
  );
  if (failed.length > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
