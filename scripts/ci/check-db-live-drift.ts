/**
 * Read-only: the live database must match prisma/schema.prisma.
 *
 * Runs `prisma migrate diff` (no writes) and fails on any planned statement
 * other than dropping a unique index schema.prisma cannot declare; those are
 * owned by the migrations after `0_baseline`. A non-empty remainder means the
 * catalog was changed by hand or a migration is missing.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  droppedIndexName,
  normalise,
  planStatements,
} from "../db/plan-statements";
import { sidecarOwnedUniqueIndexes } from "../db/sidecar-objects";

const ROOT = path.join(__dirname, "..", "..");

function main(): void {
  // prisma.config.ts reads only DIRECT_URL; without it the diff targets a placeholder.
  if (!process.env.DIRECT_URL) {
    console.error("::error title=DB drift check::DIRECT_URL is not set");
    process.exit(1);
  }
  const plan = execFileSync(
    path.join(ROOT, "node_modules", ".bin", "prisma"),
    [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      path.join(ROOT, "prisma", "schema.prisma"),
      "--script",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const owned = sidecarOwnedUniqueIndexes();
  const unexpected = planStatements(plan).filter((statement) => {
    const dropped = droppedIndexName(statement);
    return !(dropped && owned.has(dropped));
  });

  if (unexpected.length === 0) {
    console.log("check-db-live-drift: ok — live database matches the schema");
    return;
  }
  for (const s of unexpected) {
    console.error(`::error title=Unexpected live DB drift::${normalise(s)}`);
  }
  console.error(
    `check-db-live-drift: ${unexpected.length} unexpected statement(s). Restore the catalog with a reviewed migration; never edit the live schema by hand.`,
  );
  process.exit(1);
}

main();
