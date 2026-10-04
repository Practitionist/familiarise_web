/**
 * Read-only: the live database must match prisma/schema.prisma plus the sidecars.
 *
 * Runs `prisma migrate diff` (no writes) and fails on any planned statement that
 * is not a sidecar-owned index drop or an unexpired entry in
 * `prisma/sql/known-drift.json` (`destructiveStatementsAllowed`).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  droppedIndexName,
  normalise,
  planStatements,
  sidecarOwnedUniqueIndexes,
} from "../db/preflight-push";

const ROOT = path.join(__dirname, "..", "..");
const SQL_DIR = path.join(ROOT, "prisma", "sql");

type KnownStatement = { statement: string; expires: string };

/** Every index a sidecar creates; the schema omits them, so each push plans to drop them. */
function sidecarOwnedIndexes(): Set<string> {
  const names = sidecarOwnedUniqueIndexes(SQL_DIR);
  for (const file of fs.readdirSync(SQL_DIR)) {
    if (!file.endsWith(".sql")) continue;
    const sql = fs.readFileSync(path.join(SQL_DIR, file), "utf8");
    for (const m of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

function knownStatements(): KnownStatement[] {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(SQL_DIR, "known-drift.json"), "utf8"),
  );
  const raw = (parsed as Record<string, unknown>).destructiveStatementsAllowed;
  return Array.isArray(raw) ? (raw as KnownStatement[]) : [];
}

function main(): void {
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
    console.error("::error title=DB drift check::no database URL is set");
    process.exit(1);
  }
  const prismaBin = path.join(ROOT, "node_modules", ".bin", "prisma");
  const plan = execFileSync(
    prismaBin,
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

  const owned = sidecarOwnedIndexes();
  const known = knownStatements();
  const today = new Date().toISOString().slice(0, 10);
  const unexpected = planStatements(plan).filter((statement) => {
    const dropped = droppedIndexName(statement);
    if (dropped && owned.has(dropped)) return false;
    return !known.some(
      (k) =>
        normalise(k.statement) === normalise(statement) && k.expires >= today,
    );
  });

  if (unexpected.length === 0) {
    console.log("check-db-live-drift: ok — live database matches the schema");
    return;
  }
  for (const s of unexpected) {
    console.error(`::error title=Unexpected live DB drift::${normalise(s)}`);
  }
  console.error(
    `check-db-live-drift: ${unexpected.length} unexpected statement(s). Apply the schema deliberately (never plain db push) or record the drift in prisma/sql/known-drift.json.`,
  );
  process.exit(1);
}

main();
