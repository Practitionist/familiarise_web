/**
 * Asserts the database carries every hand-written object the migration history
 * declares after `0_baseline` (CHECKs, exclusion constraints, partial indexes,
 * triggers, views, row-level security), and that the Data API roles hold no
 * table grants. `prisma migrate status` only compares migration rows, so a
 * hand-dropped trigger would leave it green; this reads the catalog.
 *
 * Skips cleanly (exit 0) when DATABASE_URL is absent.
 */
// CI writes the secret to .env as a file, which only Next loads implicitly.
import "dotenv/config";

import prisma from "../../lib/prisma";
import {
  MIGRATIONS_DIR,
  parseMigrationsDirectory,
  type SidecarObject,
} from "../db/sidecar-objects";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "::warning title=Database Sidecar Check Skipped::DATABASE_URL is unset — database sidecar verification was skipped.",
    );
    console.log("check-db-sidecars: DATABASE_URL unset — skipping");
    return;
  }

  const expected = parseMigrationsDirectory(MIGRATIONS_DIR);
  if (expected.length === 0) {
    console.error(
      "check-db-sidecars: parsed zero objects from prisma/migrations — the parser or the migrations changed shape",
    );
    process.exitCode = 1;
    return;
  }

  const names = async (query: Promise<{ name: string }[]>) =>
    new Set((await query).map((r) => r.name));

  const catalog: Record<SidecarObject["kind"], Set<string>> = {
    constraint: await names(prisma.$queryRaw<{ name: string }[]>`
      SELECT c.conname AS name FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
    `),
    index: await names(prisma.$queryRaw<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
    `),
    trigger: await names(prisma.$queryRaw<{ name: string }[]>`
      SELECT t.tgname AS name FROM pg_trigger t
      JOIN pg_class cl ON cl.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      WHERE NOT t.tgisinternal
    `),
    view: await names(prisma.$queryRaw<{ name: string }[]>`
      SELECT viewname AS name FROM pg_views WHERE schemaname = 'public'
    `),
    rls: await names(prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relrowsecurity
    `),
  };
  const missing = expected.filter((e) => !catalog[e.kind].has(e.name));

  // The roles exist only on Supabase and in CI; elsewhere this finds nothing.
  const grants = await prisma.$queryRaw<{ grantee: string; name: string }[]>`
    SELECT grantee, table_name AS name FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    ORDER BY 1, 2
  `;

  if (missing.length > 0 || grants.length > 0) {
    if (missing.length > 0) {
      console.error(
        `check-db-sidecars: FAILED — ${missing.length} of ${expected.length} migration-declared objects are missing from the database:\n`,
      );
      for (const m of missing) {
        console.error(
          `  - ${m.kind} "${m.name}"${m.table ? ` on "${m.table}"` : ""} (declared in prisma/migrations/${m.source})`,
        );
      }
    }
    if (grants.length > 0) {
      console.error(
        `check-db-sidecars: FAILED — the Data API roles hold ${grants.length} table grant(s) in public, e.g. ${grants
          .slice(0, 5)
          .map((g) => `${g.grantee} on "${g.name}"`)
          .join(", ")}`,
      );
    }
    console.error(
      "\nRun `prisma migrate status` against this database. A missing object means a migration did not apply " +
        "or someone changed the catalog by hand; restore it with a new migration, never by editing an applied one.",
    );
    process.exitCode = 1;
    return;
  }

  const count = (kind: SidecarObject["kind"]) =>
    expected.filter((e) => e.kind === kind).length;
  console.log(
    `check-db-sidecars: ok (${expected.length} migration-declared objects present — ` +
      `${count("constraint")} constraints, ${count("index")} indexes, ${count("trigger")} triggers, ` +
      `${count("view")} views, ${count("rls")} RLS tables; no Data API table grants)`,
  );
}

main()
  .catch((err) => {
    console.error("check-db-sidecars: fatal", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
