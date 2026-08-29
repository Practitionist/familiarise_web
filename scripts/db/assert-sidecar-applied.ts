/**
 * #1092 slice (via #1169 PR 9) — assert every ACTIVE sidecar guarantee exists
 * on the database DATABASE_URL points at.
 *
 * The schema is `db push`-managed and the sidecar (prisma/sql/
 * check-constraints.sql) is applied by hand via `npm run db:sidecars` — no
 * deploy step runs it, so a push or restore can silently drop
 * `slot_no_confirmed_overlap` and every CHECK with it, removing the last line
 * of defence against double-booking with no visible symptom. This script makes
 * that drift LOUD: run it after every push (`npm run db:assert-sidecars`) and
 * from any recurring health check.
 *
 * Names are parsed from the sidecar file itself so the two cannot drift, by the
 * shared parser in ./sidecar-objects.ts — which the regression test reads too,
 * so it guards this script rather than a copy of it.
 */

import fs from "fs";
import path from "path";
import prisma from "../../lib/prisma";
import { parseSidecarObjects } from "./sidecar-objects";

async function main() {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "prisma/sql/check-constraints.sql"),
    "utf8",
  );
  const { constraints: constraintNames, indexes: indexNames } =
    parseSidecarObjects(sql);

  const presentConstraints = new Set(
    (
      await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
      `
    ).map((r) => r.conname),
  );
  const presentIndexes = new Set(
    (
      await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      `
    ).map((r) => r.indexname),
  );

  const missing = [
    ...constraintNames.filter((n) => !presentConstraints.has(n)),
    ...indexNames.filter((n) => !presentIndexes.has(n)),
  ];

  if (missing.length > 0) {
    console.error(
      JSON.stringify({
        event: "sidecar_drift_detected",
        missing,
        hint: "run `npm run db:sidecars` against this database",
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      event: "sidecar_verified",
      constraints: constraintNames.length,
      uniqueIndexes: indexNames.length,
      timestamp: new Date().toISOString(),
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
