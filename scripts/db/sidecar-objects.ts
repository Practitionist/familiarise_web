/**
 * The one parser for "which hand-written objects must the database carry?".
 * It replays every migration after `0_baseline` in order: a CREATE adds an
 * object, a later DROP or RENAME removes it, so the inventory is what the
 * history leaves behind. The baseline holds only what schema.prisma declares.
 */

import fs from "node:fs";
import path from "node:path";

export type SidecarObjectKind =
  "constraint" | "index" | "trigger" | "view" | "rls";

export interface SidecarObject {
  kind: SidecarObjectKind;
  name: string;
  table?: string;
  /** Migration folder that declares it, e.g. 20261109000003_booking_guards. */
  source: string;
}

export const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
);
export const BASELINE = "0_baseline";

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

/** Index just past a block comment opened at `i`; Postgres block comments nest. */
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
 * Strip SQL comments outside string literals and dollar-quoted bodies; each
 * comment becomes a space, because Postgres treats a comment as whitespace.
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

/** Comment-free SQL with dollar-quoted bodies blanked, so DDL text inside a function is never matched. */
function ddlOnly(sql: string): string {
  return stripSqlComments(sql).replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, (body) =>
    " ".repeat(body.length),
  );
}

const IDENT = String.raw`"?([A-Za-z0-9_]+)"?`;
const re = (source: string) => new RegExp(source, "gi");

const ALTER_TABLE = re(
  String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}([^;]*)`,
);
const TABLE_CLAUSES = re(
  String.raw`\b(?:(ADD|DROP)\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${IDENT}|RENAME\s+CONSTRAINT\s+${IDENT}\s+TO\s+${IDENT}|(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY)`,
);
const INDEX_CREATE = re(
  String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+ON\s+(?:ONLY\s+)?${IDENT}`,
);
const INDEX_DROP = re(
  String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${IDENT}`,
);
const INDEX_RENAME = re(
  String.raw`ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+RENAME\s+TO\s+${IDENT}`,
);
const TRIGGER_CREATE = re(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${IDENT}[^;]*?\bON\s+${IDENT}`,
);
const TRIGGER_DROP = re(
  String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+${IDENT}`,
);
const VIEW_CREATE = re(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+${IDENT}`,
);
const VIEW_DROP = re(String.raw`DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?${IDENT}`);

type Event = {
  at: number;
  kind: SidecarObjectKind;
  op: "create" | "drop" | "rename";
  name: string;
  to?: string;
  table?: string;
};

/** The CREATE / DROP / RENAME events in one file, in statement order. */
function eventsOf(sql: string): Event[] {
  const text = ddlOnly(sql);
  const events: Event[] = [];
  for (const m of text.matchAll(ALTER_TABLE)) {
    const table = m[1];
    const offset = (m.index ?? 0) + m[0].length - m[2].length;
    for (const c of m[2].matchAll(TABLE_CLAUSES)) {
      const at = offset + (c.index ?? 0);
      if (c[1]) {
        const op = c[1].toUpperCase() === "ADD" ? "create" : "drop";
        events.push({ at, kind: "constraint", op, table, name: c[2] });
      } else if (c[3]) {
        events.push({
          at,
          kind: "constraint",
          op: "rename",
          table,
          name: c[3],
          to: c[4],
        });
      } else {
        const op = c[5].toUpperCase() === "ENABLE" ? "create" : "drop";
        events.push({ at, kind: "rls", op, table, name: table });
      }
    }
  }
  const add = (
    pattern: RegExp,
    build: (m: RegExpMatchArray) => Omit<Event, "at">,
  ) => {
    for (const m of text.matchAll(pattern))
      events.push({ at: m.index ?? 0, ...build(m) });
  };
  add(INDEX_CREATE, (m) => ({
    kind: "index",
    op: "create",
    name: m[1],
    table: m[2],
  }));
  add(INDEX_DROP, (m) => ({ kind: "index", op: "drop", name: m[1] }));
  add(INDEX_RENAME, (m) => ({
    kind: "index",
    op: "rename",
    name: m[1],
    to: m[2],
  }));
  add(TRIGGER_CREATE, (m) => ({
    kind: "trigger",
    op: "create",
    name: m[1],
    table: m[2],
  }));
  add(TRIGGER_DROP, (m) => ({
    kind: "trigger",
    op: "drop",
    name: m[1],
    table: m[2],
  }));
  add(VIEW_CREATE, (m) => ({ kind: "view", op: "create", name: m[1] }));
  add(VIEW_DROP, (m) => ({ kind: "view", op: "drop", name: m[1] }));
  return events.sort((a, b) => a.at - b.at);
}

/** Every object one file leaves behind when applied to an empty slate. */
export function parseSidecarSql(sql: string, source: string): SidecarObject[] {
  return replay([{ source, sql }]);
}

function replay(files: { source: string; sql: string }[]): SidecarObject[] {
  const live = new Map<string, SidecarObject>();
  for (const { source, sql } of files) {
    for (const e of eventsOf(sql)) {
      const key = `${e.kind}:${e.name}`;
      if (e.op === "create") {
        live.set(key, { kind: e.kind, name: e.name, table: e.table, source });
      } else if (e.op === "drop") {
        live.delete(key);
      } else if (e.to && live.has(key)) {
        const prev = live.get(key)!;
        live.delete(key);
        live.set(`${e.kind}:${e.to}`, { ...prev, name: e.to, source });
      }
    }
  }
  return [...live.values()];
}

/** Migration folders in the order `prisma migrate deploy` applies them. */
export function migrationFolders(dir: string = MIGRATIONS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(dir, d.name, "migration.sql")),
    )
    .map((d) => d.name)
    .sort();
}

function sidecarFiles(dir: string): { source: string; sql: string }[] {
  return migrationFolders(dir)
    .filter((name) => name !== BASELINE)
    .map((name) => ({
      source: name,
      sql: fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8"),
    }));
}

/** Every object the migrations after the baseline leave in the database. */
export function parseMigrationsDirectory(
  dir: string = MIGRATIONS_DIR,
): SidecarObject[] {
  return replay(sidecarFiles(dir));
}

/** All post-baseline migration SQL in apply order, for tests that pin an invariant's text. */
export function readSidecarMigrationSql(dir: string = MIGRATIONS_DIR): string {
  return sidecarFiles(dir)
    .map((f) => f.sql)
    .join("\n");
}

/**
 * Unique indexes schema.prisma cannot declare (NULLS NOT DISTINCT), so every
 * `migrate diff` against the schema proposes dropping them.
 */
export function sidecarOwnedUniqueIndexes(
  dir: string = MIGRATIONS_DIR,
): Set<string> {
  const owned = new Set<string>();
  const live = new Set(
    parseMigrationsDirectory(dir)
      .filter((o) => o.kind === "index")
      .map((o) => o.name),
  );
  for (const { sql } of sidecarFiles(dir)) {
    for (const m of ddlOnly(sql).matchAll(
      re(
        String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}[^;]*?NULLS\s+NOT\s+DISTINCT`,
      ),
    )) {
      if (live.has(m[1])) owned.add(m[1]);
    }
  }
  return owned;
}
