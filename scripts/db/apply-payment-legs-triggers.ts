/**
 * Apply the PaymentLeg funding-sum CONSTRAINT TRIGGER
 * (prisma/sql/payment-legs-triggers.sql).
 *
 * `prisma db push` / `prisma migrate` do NOT manage triggers, so this must
 * run after every push/reset — same story as ledger-triggers.sql, which is
 * where this pattern comes from. Idempotent (DROP TRIGGER IF EXISTS +
 * CREATE OR REPLACE FUNCTION).
 *
 * Usage: `npm run db:leg-triggers`
 *   (or `npx tsx -r dotenv/config scripts/db/apply-payment-legs-triggers.ts`)
 */
import { readFileSync } from "fs";
import { join } from "path";

import prisma from "../../lib/prisma";

async function main(): Promise<void> {
  const sqlPath = join(
    process.cwd(),
    "prisma",
    "sql",
    "payment-legs-triggers.sql",
  );
  const raw = readFileSync(sqlPath, "utf8");

  // Prisma's $executeRawUnsafe runs one statement per call (extended protocol),
  // so split the file on the `-- SPLIT` markers and run each non-empty statement.
  const statements = raw
    .split(/^--\s*SPLIT\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--.*\n?)*$/.test(s));

  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }

  console.log(
    `✅ Applied payment-legs sum trigger (${statements.length} statements) from ${sqlPath}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Failed to apply payment-legs triggers:", err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
