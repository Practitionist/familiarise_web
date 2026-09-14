/**
 * #1320 — one-off, idempotent: merge touching custom availability rows for
 * every consultant so storage is one row per contiguous window. The custom
 * twin of coalesce-weekly-availability.ts.
 *
 * DRY RUN by default; pass --apply to write. This runs against whatever
 * DATABASE_URL points at, and there is one Supabase project behind dev and
 * prod, so --apply is an owner-approved, backed-up operation.
 */
import "dotenv/config";
import prisma from "../../lib/prisma";
import {
  coalesceConsultantCustomRows,
  mergeAdjacentCustomRows,
} from "../../utils/scheduling-engine/mergeAdjacentWeeklyRows";

async function main() {
  const apply = process.argv.includes("--apply");
  const profiles = await prisma.consultantProfile.findMany({
    where: { availabilityWindowsCustom: { some: {} } },
    select: { id: true, availabilityWindowsCustom: true },
  });
  let candidates = 0;
  let foldedRows = 0;
  for (const p of profiles) {
    const merged = mergeAdjacentCustomRows(p.availabilityWindowsCustom);
    const delta = p.availabilityWindowsCustom.length - merged.length;
    if (delta === 0) continue;
    candidates++;
    foldedRows += delta;
    console.log(
      JSON.stringify({
        event: apply ? "coalesce_apply" : "coalesce_dry_run",
        consultantProfileId: p.id,
        before: p.availabilityWindowsCustom.length,
        after: merged.length,
      }),
    );
    if (apply) {
      await prisma.$transaction((tx) => coalesceConsultantCustomRows(tx, p.id));
    }
  }
  console.log(
    JSON.stringify({
      event: "coalesce_summary",
      mode: apply ? "apply" : "dry-run",
      consultantsScanned: profiles.length,
      consultantsWithAdjacentRows: candidates,
      rowsFolded: foldedRows,
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
