/**
 * Backfill `ModerationReport.resolution` before the sidecar CHECK lands.
 *
 * The sidecar `moderation_report_resolution_chk` refuses a closed report
 * without a resolution and an open one with one. Every report written since
 * that constraint was designed carries both, but reports written BEFORE it
 * do not: their status moved and nothing filled the new column, so
 * `ALTER TABLE ... ADD CONSTRAINT` fails on the first legacy row it meets and
 * the whole sidecar apply aborts.
 *
 * This writes the disposition the status already implies:
 * DISMISSED / ACTION_TAKEN / ESCALATED get the matching resolution, and the
 * open statuses are left alone (their resolution must stay NULL). It is
 * idempotent — a second run matches nothing.
 *
 * Run it BEFORE `npm run db:sidecars`:
 *   npx tsx -r dotenv/config scripts/db/backfill-moderation-resolution.ts
 *   npx tsx -r dotenv/config scripts/db/backfill-moderation-resolution.ts --dry-run
 */
import prisma from "../../lib/prisma";

const CLOSED_BY_STATUS = [
  { status: "DISMISSED", resolution: "DISMISSED" },
  { status: "ACTION_TAKEN", resolution: "ACTION_TAKEN" },
  { status: "ESCALATED", resolution: "ESCALATED" },
] as const;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const counts: Record<string, number> = {};

  for (const { status, resolution } of CLOSED_BY_STATUS) {
    const where = { status, resolution: null };
    const rows = await prisma.moderationReport.findMany({
      where,
      select: { id: true },
    });
    counts[status] = rows.length;
    if (rows.length === 0 || dryRun) continue;
    await prisma.moderationReport.updateMany({
      where,
      data: { resolution },
    });
  }

  // An open report must NOT carry a resolution: the CHECK refuses that too.
  const openWithResolution = await prisma.moderationReport.count({
    where: {
      status: { in: ["PENDING", "UNDER_REVIEW"] },
      resolution: { not: null },
    },
  });
  if (openWithResolution > 0 && !dryRun) {
    await prisma.moderationReport.updateMany({
      where: {
        status: { in: ["PENDING", "UNDER_REVIEW"] },
        resolution: { not: null },
      },
      data: { resolution: null },
    });
  }

  console.log(
    JSON.stringify({
      event: dryRun
        ? "moderation_resolution_backfill_dry_run"
        : "moderation_resolution_backfill_complete",
      backfilled: counts,
      openWithResolutionCleared: openWithResolution,
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
