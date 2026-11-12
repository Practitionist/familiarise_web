/**
 * CI guard — the live database must already contain everything THIS pull
 * request's schema change adds.
 *
 * One Postgres project serves development, production AND every Netlify deploy
 * preview, so a preview runs the BRANCH's code against the LIVE database. A
 * column the branch's schema declares and the database lacks is therefore a 500
 * on every read of that model, not a build error: Prisma's generated client
 * selects it, Postgres says it does not exist, and the error escapes the render.
 *
 * Two steps:
 *
 *   1. Diff the MERGE BASE's schema against this branch's schema. Both are
 *      schema files, so the diff is exactly what this pull request adds and
 *      nothing else — which matters because the normal shape of work here is a
 *      stacked train, and a branch behind its base must not be judged on
 *      objects it never touched.
 *   2. Ask the live catalog whether each of those objects is there.
 *
 * Only objects whose absence makes a query FAIL are checked: a column, a
 * table, an enum type, an enum value. A missing index costs a sequential scan,
 * not a 500.
 *
 * The other direction — the database carrying objects the schema does not want
 * — is deliberately not read. That is the reconcile push's business, it is not
 * a runtime failure, and a live-database check in BOTH directions blocks every
 * schema-bearing pull request, which is why the earlier whole-schema drift
 * check was moved out of pull-request CI. See docs/prisma/README.md.
 *
 * `--live` is the release gate for a pull request into `prod`: it diffs the
 * whole schema against the live database (`--from-config-datasource`) instead
 * of against the merge base, so code cannot ship before the human-run push.
 * Sidecar objects and the database-ahead direction are still never read.
 *
 * Read-only: it reads a schema file and reads the catalog. It never writes.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

import { planStatements } from "../db/plan-statements";

const ROOT = path.join(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

/**
 * A database object this branch's schema adds, in the shape the live catalog
 * can be asked about.
 */
export type RequiredObject = {
  kind: "column" | "table" | "enumType" | "enumValue";
  /** The table a column belongs to; the type an enum value belongs to. */
  owner?: string;
  /** The column's, table's, type's or enum value's own name. */
  name: string;
  /** The SQL that creates it, printed so the fix is a copy-paste. */
  ddl: string;
};

/**
 * Split a planned statement into its clauses.
 *
 * Prisma writes ONE `ALTER TABLE` for several changes and separates them with
 * a comma, so the table named in the first clause governs the ones after it —
 * which is why the caller carries the table down rather than reading it per
 * clause.
 *
 * A comma separates only at the top level: one inside a parenthesis
 * (`CREATE TABLE`'s column list) or inside a quoted string is part of a value,
 * not a boundary.
 */
export function splitClauses(statement: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let current = "";
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (quote) {
      current += ch;
      // A doubled quote is an escaped quote, not a terminator.
      if (ch === quote) {
        if (statement[i + 1] === quote) {
          current += statement[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if ((ch === "," || ch === "\n") && depth === 0) {
      if (current.trim()) clauses.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

/**
 * Every object in a plan that this branch's schema adds and that the database
 * would therefore have to already contain.
 *
 * Only the "the database is missing it" direction is read. A plan that also
 * drops things is normal — the reconcile push's business — and reading it here
 * is what made the previous live-database pull-request check unusable.
 */
export function requiredObjects(plan: string): RequiredObject[] {
  const out: RequiredObject[] = [];
  for (const statement of planStatements(plan)) {
    const createdTable = /\bCREATE\s+TABLE\s+"([^"]+)"/i.exec(statement);
    if (createdTable) {
      const table = createdTable[1];
      out.push({ kind: "table", name: table, ddl: `${statement.trim()};` });
      // An earlier push of the same branch may have created the table without
      // a column added since, so each column is required on its own.
      const open = statement.indexOf("(");
      const close = statement.lastIndexOf(")");
      if (open !== -1 && close > open) {
        for (const clause of splitClauses(statement.slice(open + 1, close))) {
          const column = /^"([^"]+)"/.exec(clause);
          if (!column) continue;
          out.push({
            kind: "column",
            owner: table,
            name: column[1],
            ddl: `ALTER TABLE "${table}" ADD COLUMN ${clause};`,
          });
        }
      }
      continue;
    }

    const createdType = /\bCREATE\s+TYPE\s+"([^"]+)"/i.exec(statement);
    if (createdType) {
      out.push({
        kind: "enumType",
        name: createdType[1],
        ddl: `${statement.trim()};`,
      });
      // Prisma recreates an enum whose value set changed by building a
      // replacement type under a `_new` suffix and swapping it in. That plan
      // carries no `ALTER TYPE … ADD VALUE`, so a label the branch's schema
      // declares and the live enum lacks would otherwise go unchecked — the
      // same 500 as the missing `COUNTERED` value. Each label of the
      // replacement is required of the ORIGINAL type.
      if (createdType[1].endsWith("_new")) {
        const owner = createdType[1].replace(/_new$/, "");
        const labels = /\bAS\s+ENUM\s*\(([^)]*)\)/i.exec(statement)?.[1] ?? "";
        for (const m of labels.matchAll(/'((?:[^']|'')*)'/g)) {
          const name = m[1].replace(/''/g, "'");
          out.push({
            kind: "enumValue",
            owner,
            name,
            ddl: `ALTER TYPE "${owner}" ADD VALUE IF NOT EXISTS '${name}';`,
          });
        }
      }
      continue;
    }

    const addedValue =
      /\bALTER\s+TYPE\s+"([^"]+)"\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/i.exec(
        statement,
      );
    if (addedValue) {
      out.push({
        kind: "enumValue",
        owner: addedValue[1],
        name: addedValue[2],
        ddl: `${statement.trim()};`,
      });
      continue;
    }

    const table = /\bALTER\s+TABLE\s+"([^"]+)"/i.exec(statement)?.[1];
    if (!table) continue;
    for (const clause of splitClauses(statement)) {
      const addedColumn = /\bADD\s+COLUMN\s+("?[^"\s]+"?)/i.exec(clause);
      if (!addedColumn) continue;
      // The first clause of the statement carries the table name; the ones
      // after it inherit it. Rebuild the statement from the table so the DDL
      // printed below is runnable either way.
      const body = clause
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^ALTER\s+TABLE\s+"[^"]+"\s*/i, "");
      out.push({
        kind: "column",
        owner: table,
        name: addedColumn[1].replace(/"/g, ""),
        ddl: `ALTER TABLE "${table}" ${body};`,
      });
    }
  }
  return out;
}

/** How an object is named in a report line. */
export function describeObject(o: RequiredObject): string {
  if (o.kind === "column") return `${o.owner}.${o.name}`;
  if (o.kind === "enumValue") return `${o.owner}.${o.name} (enum value)`;
  return o.name;
}

/**
 * `git`, resolved to a fixed location.
 *
 * A bare command name is resolved through PATH, and PATH is not a list of
 * fixed, unwriteable directories — on a machine that can write to any PATH
 * entry, "git" may not be git. The Prisma binary below is already an absolute
 * path for the same reason.
 */
const GIT_CANDIDATES = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/bin/git",
];

function gitBin(): string {
  const found = GIT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `git was not found in any fixed location (${GIT_CANDIDATES.join(", ")})`,
    );
  }
  return found;
}

/**
 * The git ref this branch diverged from.
 *
 * The ref reaches a child process, so it is checked to be a ref and nothing
 * else: a leading `-` would make git read it as an option rather than a name.
 */
export function baseRef(argv: string[]): string {
  const i = argv.indexOf("--base");
  const ref = i !== -1 && argv[i + 1] ? argv[i + 1] : "origin/dev";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) {
    throw new Error(`--base is not a usable git ref: ${ref}`);
  }
  return ref;
}

/** The base branch's schema, as a file the diff can read. */
function baseSchemaFile(ref: string): string {
  const git = gitBin();
  const mergeBase = execFileSync(git, ["merge-base", "HEAD", ref], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!mergeBase) {
    throw new Error(`no merge base between HEAD and ${ref}`);
  }
  const schema = execFileSync(
    git,
    ["show", `${mergeBase}:prisma/schema.prisma`],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const file = path.join(
    os.tmpdir(),
    `check-db-schema-required-${mergeBase.slice(0, 12)}.prisma`,
  );
  fs.writeFileSync(file, schema);
  return file;
}

/** The plan that turns the base schema into this branch's schema. */
function branchPlan(base: string): string {
  const prismaBin = path.join(ROOT, "node_modules", ".bin", "prisma");
  return execFileSync(
    prismaBin,
    [
      "migrate",
      "diff",
      "--from-schema",
      base,
      "--to-schema",
      SCHEMA,
      "--script",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** The plan that turns the live database into this branch's schema; needs DIRECT_URL (prisma.config.ts). */
function livePlan(): string {
  if (!process.env.DIRECT_URL) {
    throw new Error(
      "DIRECT_URL is not set, so the live database cannot be diffed",
    );
  }
  const prismaBin = path.join(ROOT, "node_modules", ".bin", "prisma");
  return execFileSync(
    prismaBin,
    [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      SCHEMA,
      "--script",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Every table, column, enum type and enum value in the live database. */
export type LiveCatalog = {
  tables: Set<string>;
  columns: Set<string>;
  enumTypes: Set<string>;
  enumValues: Set<string>;
};

/** Read the live catalog. One round trip. */
export async function readLiveCatalog(
  connectionString: string,
): Promise<LiveCatalog> {
  const db = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
  });
  await db.connect();
  try {
    const { rows } = await db.query<{
      kind: string;
      name: string;
      value: string | null;
    }>(`
      SELECT 'table'::text AS kind, c.relname::text AS name, NULL::text AS value
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      UNION ALL
      SELECT 'column'::text, c.relname::text, a.attname::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'enumType'::text, t.typname::text, NULL::text
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
      UNION ALL
      SELECT 'enumValue'::text, t.typname::text, e.enumlabel::text
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
    `);
    const catalog: LiveCatalog = {
      tables: new Set<string>(),
      columns: new Set<string>(),
      enumTypes: new Set<string>(),
      enumValues: new Set<string>(),
    };
    for (const r of rows) {
      if (r.kind === "table") catalog.tables.add(r.name);
      else if (r.kind === "column") catalog.columns.add(`${r.name}.${r.value}`);
      else if (r.kind === "enumType") catalog.enumTypes.add(r.name);
      else catalog.enumValues.add(`${r.name}.${r.value}`);
    }
    return catalog;
  } finally {
    await db.end();
  }
}

/** The fix line for a missing object; a NOT NULL column with no default is flagged, since Postgres rejects it on a table with rows. */
export function printedFix(o: RequiredObject): string {
  const rejectsRows =
    o.kind === "column" &&
    /\bNOT\s+NULL\b/i.test(o.ddl) &&
    !/\bDEFAULT\b/i.test(o.ddl);
  return rejectsRows
    ? `${o.ddl}  -- NOT NULL with no default: fails if "${o.owner}" already has rows`
    : o.ddl;
}

/** Is this object present in the live database? */
export function isPresent(o: RequiredObject, catalog: LiveCatalog): boolean {
  switch (o.kind) {
    case "column":
      return catalog.columns.has(`${o.owner}.${o.name}`);
    case "table":
      return catalog.tables.has(o.name);
    case "enumType":
      // Prisma recreates an enum whose value set shrank by building a
      // replacement type under a `_new` suffix and swapping it in. The object
      // the branch's code uses is the ORIGINAL type, which the database already
      // has, so the replacement is not a requirement.
      return catalog.enumTypes.has(o.name.replace(/_new$/, ""));
    case "enumValue":
      return catalog.enumValues.has(`${o.owner}.${o.name}`);
  }
}

/** What the database lacks; a missing table's CREATE already carries its columns, so they are not listed again. */
export function missingObjects(
  required: RequiredObject[],
  catalog: LiveCatalog,
): RequiredObject[] {
  const missing = required.filter((o) => !isPresent(o, catalog));
  const missingTables = new Set(
    missing.filter((o) => o.kind === "table").map((o) => o.name),
  );
  return missing.filter(
    (o) => !(o.kind === "column" && o.owner && missingTables.has(o.owner)),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const connectionString = process.env.DATABASE_URL;
  // The release gate has nothing to skip to: without the live database it must fail.
  if (live && (!connectionString || !process.env.DIRECT_URL)) {
    console.error(
      "check-db-schema-required: --live needs DATABASE_URL and DIRECT_URL — refusing to pass without the live database.",
    );
    process.exitCode = 1;
    return;
  }
  if (!connectionString) {
    // A gate that cannot run must not pass. Outside CI there is simply no live
    // database to compare against and skipping is the useful answer; inside
    // CI the secret being unset or renamed is a fault, not an answer.
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(
        "check-db-schema-required: DATABASE_URL is empty in CI — refusing to pass without a live database to compare against.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      "check-db-schema-required: DATABASE_URL unset — skipping (no live database to compare against)",
    );
    return;
  }

  let plan: string;
  let ref = "origin/dev";
  try {
    if (live) {
      ref = "the live database";
      plan = livePlan();
    } else {
      ref = baseRef(argv);
      plan = branchPlan(baseSchemaFile(ref));
    }
  } catch (error) {
    // A diff that cannot be computed is not a pass.
    console.error(
      "check-db-schema-required: could not compare this branch's schema against its base.",
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const required = requiredObjects(plan);
  if (required.length === 0) {
    console.log(
      `check-db-schema-required: ok — this branch adds no schema object the live database would have to already contain (base ${ref}).`,
    );
    return;
  }

  // --live reads the catalog from the same DIRECT_URL target the diff used.
  const catalog = await readLiveCatalog(
    (live && process.env.DIRECT_URL) || connectionString,
  );
  const missing = missingObjects(required, catalog);

  if (missing.length === 0) {
    console.log(
      `check-db-schema-required: ok — all ${required.length} object(s) this branch adds are already in the live database.`,
    );
    return;
  }

  console.error(
    `\ncheck-db-schema-required: FAILED — the live database is missing ${missing.length} object(s) this branch's schema adds.\n`,
  );
  for (const o of missing) {
    console.error(
      `::error title=Missing from the live database::${describeObject(o)}`,
    );
  }
  console.error(
    [
      "",
      "One Postgres project serves development, production and every deploy preview,",
      "so this branch's preview runs against the live database. Until these objects",
      "exist, every read of them 500s with 'does not exist in the current database'.",
      "",
      "They reach the shared database only when this branch's migration merges to dev",
      "(db-migrate.yml runs `prisma migrate deploy`). Never apply them by hand: the",
      "migration would then fail on merge. Verify on a local scratch database until then.",
      "The branch's migration must create:",
      "",
      ...missing.map((o) => `  ${printedFix(o)}`),
      "",
      "docs/prisma/README.md has the ordered procedure.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] && /check-db-schema-required/.test(process.argv[1])) {
  main().catch((error) => {
    console.error("check-db-schema-required: fatal", error);
    process.exitCode = 1;
  });
}
