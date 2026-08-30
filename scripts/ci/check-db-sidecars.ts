/**
 * CI guard — the SQL sidecars must actually be applied to the live database.
 *
 * Prisma manages neither triggers nor CHECK/EXCLUDE constraints, so every money
 * invariant that cannot be expressed in PSL lives in `prisma/sql/*.sql` and is
 * applied by `npm run db:sidecars`. The trap is that `npm run db:push:schema`
 * exists as a standalone script: run it on its own and the ledger balance
 * trigger plus every money CHECK silently disappear, with nothing in the
 * application or the test suite noticing. The double-entry invariant would then
 * be enforced by application code alone.
 *
 * This asserts that every named object declared in the sidecars is present in
 * the live catalog. It parses the SQL rather than hard-coding a list, so adding
 * a constraint to the sidecar automatically extends the guard.
 *
 * Skips cleanly (exit 0) when DATABASE_URL is absent, so forks and PRs without
 * secrets are not punished.
 */
// Without this the script reads a bare process.env, finds no DATABASE_URL, and
// self-skips with exit 0 — which is how this guard reported success on every CI
// run while never once executing. CI writes the secret to .env as a FILE; only
// Next loads that implicitly. Every other DB-touching script here does the same.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import prisma from "../../lib/prisma";

const ROOT = path.join(__dirname, "..", "..");
const SQL_DIR = path.join(ROOT, "prisma", "sql");

type Expected = {
  kind: "constraint" | "index" | "trigger";
  name: string;
  table?: string;
  source: string;
};

/**
 * Strip SQL comments before matching.
 *
 * check-constraints.sql carries a block of PROPOSED constraints commented out
 * with `--`, waiting on the data to be clean enough to apply them. Matching the
 * raw text counted those proposals as required objects, so the guard demanded
 * three constraints nobody had ever agreed to create. Nothing surfaced it
 * because the guard also self-skipped in CI for want of DATABASE_URL, so it had
 * never once run — the bug and the reason nobody saw it were the same bug.
 *
 * Quote-aware: a `--` inside a string literal is data, not a comment, and
 * dollar-quoted bodies (trigger functions live in `$$ ... $$`) must survive
 * intact or every trigger in the file stops being seen.
 */
/** Index just past the closing quote of a single-quoted literal opened at `i`. */
function scanSingleQuoted(sql: string, i: number): number {
  let j = i + 1;
  while (j < sql.length && sql[j] !== "'") j++;
  return Math.min(j + 1, sql.length);
}

/** Index just past the closing tag of a dollar-quoted body opened at `i`. */
function scanDollarQuoted(sql: string, i: number, tag: string): number {
  const close = sql.indexOf(tag, i + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/**
 * Index just past the end of a block comment opened at `i`.
 *
 * Block comments NEST in Postgres, unlike C: `/* a /* b *\/ c *\/` is one
 * comment. Scanning to the first close would leave ` c *\/` behind as apparent
 * SQL.
 */
function scanBlockComment(sql: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (sql.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (sql.startsWith("*/", j)) {
      depth--;
      j += 2;
    } else {
      j++;
    }
  }
  return j;
}

/**
 * Strip SQL comments before matching.
 *
 * check-constraints.sql carries a block of PROPOSED constraints commented out
 * with `--`, waiting on the data to be clean enough to apply them. Matching the
 * raw text counted those proposals as required objects, so the guard demanded
 * three constraints nobody had ever agreed to create. Nothing surfaced it
 * because the guard also self-skipped in CI for want of DATABASE_URL, so it had
 * never once run — the bug and the reason nobody saw it were the same bug.
 *
 * Two things must survive: a `--` inside a string literal is data, and trigger
 * bodies live in dollar-quoted blocks that routinely contain `--`.
 *
 * A comment is replaced by a SPACE, never by nothing. Postgres treats comments
 * as whitespace, so one can legally be the only separator between two tokens —
 * dropping it turned `CREATE/* x *\/INDEX "i"` into `CREATEINDEX "i"`, and the
 * parser then missed an object that IS declared.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const end = scanDollarQuoted(sql, i, dollar[0]);
      out += sql.slice(i, end);
      i = end;
    } else if (sql[i] === "'") {
      const end = scanSingleQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (sql.startsWith("/*", i)) {
      i = scanBlockComment(sql, i);
      out += " ";
    } else {
      out += sql[i++];
    }
  }
  return out;
}

function parseSidecars(): Expected[] {
  const expected: Expected[] = [];
  for (const file of fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith(".sql"))) {
    const sql = stripSqlComments(
      fs.readFileSync(path.join(SQL_DIR, file), "utf8"),
    );

    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/gi,
    )) {
      expected.push({
        kind: "constraint",
        table: m[1],
        name: m[2],
        source: file,
      });
    }
    for (const m of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi,
    )) {
      expected.push({ kind: "index", name: m[1], source: file });
    }
    for (const m of sql.matchAll(
      /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)/gi,
    )) {
      expected.push({ kind: "trigger", name: m[1], source: file });
    }
  }
  return expected;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("check-db-sidecars: DATABASE_URL unset — skipping");
    return;
  }

  const expected = parseSidecars();
  if (expected.length === 0) {
    console.error(
      "check-db-sidecars: parsed zero objects from prisma/sql — the parser or the sidecars changed shape",
    );
    process.exitCode = 1;
    return;
  }

  const constraints = new Set(
    (
      await prisma.$queryRaw<{ conname: string }[]>`
        SELECT c.conname FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
      `
    ).map((r) => r.conname),
  );
  const indexes = new Set(
    (
      await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      `
    ).map((r) => r.indexname),
  );
  const triggers = new Set(
    (
      await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT t.tgname FROM pg_trigger t
        JOIN pg_class cl ON cl.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        WHERE NOT t.tgisinternal
      `
    ).map((r) => r.tgname),
  );

  const missing: Expected[] = [];
  for (const e of expected) {
    const present =
      e.kind === "constraint"
        ? constraints.has(e.name)
        : e.kind === "index"
          ? indexes.has(e.name)
          : triggers.has(e.name);
    if (!present) missing.push(e);
  }

  if (missing.length > 0) {
    console.error(
      `check-db-sidecars: FAILED — ${missing.length} of ${expected.length} sidecar objects are missing from the live database:\n`,
    );
    for (const m of missing) {
      console.error(
        `  - ${m.kind} "${m.name}"${m.table ? ` on "${m.table}"` : ""} (declared in prisma/sql/${m.source})`,
      );
    }
    console.error(
      "\nRun `npm run db:sidecars` against this database. If this fired right after a schema " +
        "change, someone almost certainly ran `npm run db:push:schema` instead of `npm run db:push` — " +
        "the former does not reapply the trigger or the CHECK constraints.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-db-sidecars: ok (${expected.length} sidecar objects present — ` +
      `${expected.filter((e) => e.kind === "constraint").length} constraints, ` +
      `${expected.filter((e) => e.kind === "index").length} indexes, ` +
      `${expected.filter((e) => e.kind === "trigger").length} triggers)`,
  );
}

// Only run when invoked as a script. `stripSqlComments` is unit-tested, and a
// bare `main()` at module scope meant importing it opened a database connection
// and raced the test runner's teardown.
if (process.argv[1] && /check-db-sidecars/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error("check-db-sidecars: fatal", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
