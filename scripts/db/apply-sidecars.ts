/**
 * Apply Postgres sidecar DDL files (`prisma/sql/*.sql`):
 *   - `check-constraints.sql`     (--check-constraints)
 *   - `ledger-triggers.sql`       (--ledger-triggers)
 *   - `payment-legs-triggers.sql` (--payment-legs-triggers)
 *
 * `prisma db push` / `prisma migrate` do NOT manage CHECK constraints,
 * partial unique indexes, or constraint triggers, so this must run after every
 * push/reset. Each statement executes in its own short transaction with
 * `SET LOCAL lock_timeout = '3s'` so an unobtainable ACCESS EXCLUSIVE lock
 * fails fast instead of queueing behind an open transaction and blocking the
 * table in FIFO order.
 *
 * Flags:
 *   --all (default when no target flag is passed)
 *   --check-constraints
 *   --ledger-triggers
 *   --payment-legs-triggers
 *   --dry-run
 */
import { readFileSync } from "fs";
import { join } from "path";

import prisma from "../../lib/prisma";
import { splitSqlStatements } from "./sql-chunks";

type SidecarTarget = {
  flag: string;
  label: string;
  file: string;
};

const SIDECAR_TARGETS: SidecarTarget[] = [
  {
    flag: "--check-constraints",
    label: "CHECK constraints",
    file: "check-constraints.sql",
  },
  {
    flag: "--ledger-triggers",
    label: "ledger balance trigger",
    file: "ledger-triggers.sql",
  },
  {
    flag: "--payment-legs-triggers",
    label: "payment-legs sum trigger",
    file: "payment-legs-triggers.sql",
  },
];

function resolveTargets(argv: string[]): SidecarTarget[] {
  if (argv.includes("--all")) return SIDECAR_TARGETS;
  const selected = SIDECAR_TARGETS.filter((t) => argv.includes(t.flag));
  return selected.length > 0 ? selected : SIDECAR_TARGETS;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const targets = resolveTargets(process.argv.slice(2));

  for (const target of targets) {
    const sqlPath = join(process.cwd(), "prisma", "sql", target.file);
    const raw = readFileSync(sqlPath, "utf8");
    const statements = splitSqlStatements(raw);

    for (const stmt of statements) {
      if (dryRun) {
        console.log(stmt.replace(/^(--.*\n)+/, "").trim());
        continue;
      }
      await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe(stmt),
      ]);
    }

    console.log(
      dryRun
        ? `🔎 Dry run: ${statements.length} statements from ${sqlPath} (nothing executed)`
        : `✅ Applied ${target.label} (${statements.length} statements) from ${sqlPath}`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Failed to apply DB sidecars:", err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
