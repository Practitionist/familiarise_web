/**
 * CI guard for AGENTS.md §1.5: comment lines added in a PR may not cite ticket
 * numbers (`#1234`, `fix #568`), planning ids (`P1-W02a`) or "owner decision".
 * A line-level heuristic, not a parser: only added lines are checked, and text
 * inside quotes on that line is skipped.
 *
 * Usage: tsx scripts/ci/check-comment-archaeology.ts <base-ref>
 */
import { execFileSync } from "node:child_process";

const SELF = "scripts/ci/check-comment-archaeology.ts";

// `#1234` not preceded by a word char, `/`, `&` or `=` (URL fragments, colours
// such as `#000` and HTML entities pass), a ticket word before any `#n`, or a
// planning id.
export const BANNED =
  /(?<![\w/&=#-])#\d{4,5}\b|\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|issue|pr|ticket|see|part of|follow-up to)\s*#\d+\b|\bP\d-W\d+[a-z]?\b|owner decision/i;

// A git ref name, never an option: no leading `-`, no whitespace or `..`.
const REF = /^(?!-)(?!.*\.\.)[\w./@^~-]+$/;

/** The comment part of a code line outside any quoted string, or null. */
export function commentOf(line: string, sql = false): string | null {
  if (/^\s*\*/.test(line)) return line.slice(line.indexOf("*"));
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && !sql) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || (!sql && (c === '"' || c === "`"))) {
      quote = c;
      continue;
    }
    const pair = line.slice(i, i + 2);
    if (pair === "/*") return line.slice(i);
    if (sql ? pair === "--" : pair === "//" && line[i - 1] !== ":")
      return line.slice(i);
  }
  return null;
}

/** `file:line: comment` for every added comment line in a `git diff -U0`. */
export function findViolations(diff: string): string[] {
  const violations: string[] = [];
  let file = "";
  let lineNo = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++ ")) {
      file = row.slice(6);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(row);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!row.startsWith("+")) continue;
    const current = lineNo++;
    if (file === SELF) continue;
    const comment = commentOf(row.slice(1), file.endsWith(".sql"));
    if (comment !== null && BANNED.test(comment)) {
      violations.push(`${file}:${current}: ${comment.trim()}`);
    }
  }
  return violations;
}

function main(base: string | undefined): void {
  if (!base) {
    console.log("No base ref given; nothing to compare.");
    return;
  }
  if (!REF.test(base)) {
    console.error(`Refusing base ref ${JSON.stringify(base)}: not a ref name.`);
    process.exit(1);
  }
  const diff = execFileSync(
    "git",
    [
      "diff",
      "-U0",
      "--no-color",
      "--end-of-options",
      `${base}...HEAD`,
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.mjs",
      "*.js",
      "*.sql",
      "*.prisma",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const violations = findViolations(diff);
  if (violations.length > 0) {
    console.error(
      "Comments may state only the current invariant (AGENTS.md §1.5). Remove the ticket or planning reference:\n",
    );
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("Comment archaeology guard: clean.");
}

if (process.argv[1]?.endsWith("check-comment-archaeology.ts")) {
  main(process.argv[2]);
}
