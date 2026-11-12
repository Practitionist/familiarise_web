/** Statement-level helpers over `prisma migrate diff --script` plans and migration files. */

/** Collapse whitespace and drop a trailing `;`, so two renderings of one statement compare equal. */
export const normalise = (s: string) =>
  s.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();

/** The index a `DROP INDEX` statement names, or null for any other statement. */
export function droppedIndexName(statement: string): string | null {
  return (
    /^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/i.exec(
      statement,
    )?.[1] ?? null
  );
}

/**
 * The executable statements of a plan or migration file, comment lines removed.
 * Splits on statement-ending `;` only: one inside a quoted literal or identifier
 * (with `''`/`""` escapes), a dollar-quoted body or a comment is part of the text.
 */
export function planStatements(sql: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const dollar = ch === "$" ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
    if (dollar) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length);
      i = close === -1 ? sql.length : close + dollar[0].length;
    } else if (ch === "'" || ch === '"') {
      // A doubled quote is an escape, so scanning on reads it as close-then-open.
      const close = sql.indexOf(ch, i + 1);
      i = close === -1 ? sql.length : close + 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      if (ch === ";") {
        chunks.push(sql.slice(start, i));
        start = i + 1;
      }
      i++;
    }
  }
  chunks.push(sql.slice(start));
  return chunks
    .map((chunk) => chunk.replace(/^[ \t]*(--[^\n]*\n?)+/gm, "").trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith("--"));
}
