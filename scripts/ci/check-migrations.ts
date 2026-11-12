/**
 * Linear-history and transaction lint for prisma/migrations, run in CI.
 *
 * - Every migration.sql is `BEGIN; SET LOCAL lock_timeout …; … COMMIT;`, because
 *   Prisma 7.10 `migrate deploy` otherwise commits each statement on its own.
 *   The one exception is a file holding a single CREATE/DROP INDEX CONCURRENTLY.
 * - Against the base ref: a new folder sorts after the base's newest, and no
 *   migration file the base already has is edited or deleted (`migrate status`
 *   does not notice an edited applied migration).
 * - `migrate diff --from-migrations … --to-schema prisma/schema.prisma` is empty
 *   apart from dropping the unique indexes schema.prisma cannot declare.
 *
 * Usage: SHADOW_DATABASE_URL=… tsx scripts/ci/check-migrations.ts [<base-ref>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  droppedIndexName,
  normalise,
  planStatements,
} from "../db/plan-statements";
import {
  MIGRATIONS_DIR,
  migrationFolders,
  sidecarOwnedUniqueIndexes,
} from "../db/sidecar-objects";

const ROOT = path.join(__dirname, "..", "..");
// A git ref name, never an option: no leading `-`, no whitespace or `..`.
const REF = /^(?!-)(?!.*\.\.)[\w./@^~-]+$/;

/** Transaction-shape problems in one migration file; empty when it is well formed. */
export function lintMigrationSql(sql: string): string[] {
  const statements = planStatements(sql).map(normalise);
  if (statements.length === 0) return ["is empty"];
  if (statements.some((s) => /\bCONCURRENTLY\b/i.test(s))) {
    return statements.length === 1
      ? []
      : [
          "holds CONCURRENTLY alongside other statements; it must be the file's only statement",
        ];
  }
  const problems: string[] = [];
  if (!/^BEGIN$/i.test(statements[0]))
    problems.push("does not start with BEGIN;");
  if (!/^SET LOCAL lock_timeout\b/i.test(statements[1] ?? ""))
    problems.push("does not set SET LOCAL lock_timeout right after BEGIN;");
  if (!/^COMMIT$/i.test(statements[statements.length - 1]))
    problems.push("does not end with COMMIT;");
  const inner = statements.slice(1, -1);
  if (
    inner.some((s) =>
      /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)$/i.test(s),
    )
  )
    problems.push("opens or closes a second transaction");
  if (inner.some((s) => /^(SET|RESET)\b/i.test(s) && !/^SET LOCAL\b/i.test(s)))
    problems.push(
      "uses a session-level SET or RESET, which leaks into later migrations; use SET LOCAL",
    );
  return problems;
}

/** Folders a branch adds that do not sort after the newest folder on its base. */
export function outOfOrder(baseFolders: string[], added: string[]): string[] {
  const newest = [...baseFolders].sort().at(-1);
  return newest ? added.filter((name) => name <= newest) : [];
}

/** Diff statements other than the drop of an index schema.prisma cannot declare. */
export function unexpectedDiff(plan: string, owned: Set<string>): string[] {
  return planStatements(plan)
    .filter((s) => {
      const dropped = droppedIndexName(s);
      return !(dropped && owned.has(dropped));
    })
    .map(normalise);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function main(base: string | undefined): void {
  const errors: string[] = [];

  for (const folder of migrationFolders()) {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, folder, "migration.sql"),
      "utf8",
    );
    for (const problem of lintMigrationSql(sql))
      errors.push(`${folder}/migration.sql ${problem}`);
  }

  if (base) {
    if (!REF.test(base)) {
      console.error(
        `Refusing base ref ${JSON.stringify(base)}: not a ref name.`,
      );
      process.exit(1);
    }
    // A base without prisma/migrations (the cutover itself) has nothing applied to protect.
    const hasHistory = git([
      "ls-tree",
      "--name-only",
      base,
      "prisma/",
    ]).includes("prisma/migrations");
    const baseFolders = hasHistory
      ? git(["ls-tree", "-d", "--name-only", `${base}:prisma/migrations`])
          .split("\n")
          .filter(Boolean)
      : [];
    const changes = git([
      "diff",
      "--name-status",
      "--no-renames",
      `${base}...HEAD`,
      "--",
      "prisma/migrations",
    ])
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split("\t") as [string, string]);
    const added = new Set<string>();
    for (const [status, file] of changes) {
      const folder = file.split("/")[2];
      if (!folder || !file.includes("/", "prisma/migrations/".length)) continue;
      if (baseFolders.includes(folder))
        errors.push(
          `${file} is applied on ${base} and was ${status === "D" ? "deleted" : "edited"}; add a new migration instead`,
        );
      else added.add(folder);
    }
    for (const folder of outOfOrder(baseFolders, [...added]))
      errors.push(
        `${folder} sorts before ${base}'s newest migration; rename it to a later timestamp`,
      );
  }

  if (!process.env.SHADOW_DATABASE_URL) {
    errors.push(
      "SHADOW_DATABASE_URL is unset, so the history-versus-schema diff could not run",
    );
  } else {
    const diff = spawnSync(
      path.join(ROOT, "node_modules", ".bin", "prisma"),
      [
        "migrate",
        "diff",
        "--from-migrations",
        MIGRATIONS_DIR,
        "--to-schema",
        path.join(ROOT, "prisma", "schema.prisma"),
        "--script",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (diff.status !== 0) {
      errors.push(`prisma migrate diff failed: ${diff.stderr.trim()}`);
    } else {
      for (const statement of unexpectedDiff(
        diff.stdout,
        sidecarOwnedUniqueIndexes(),
      ))
        errors.push(
          `schema.prisma and the migrations disagree; a migration is missing for: ${statement}`,
        );
    }
  }

  if (errors.length > 0) {
    for (const e of errors)
      console.error(`::error title=Migration history::${e}`);
    process.exit(1);
  }
  console.log(
    `check-migrations: ok (${migrationFolders().length} migrations, history matches schema.prisma)`,
  );
}

if (process.argv[1] && /check-migrations/.test(process.argv[1]))
  main(process.argv[2]);
