/**
 * CI guard for AGENTS.md §1.5: comment lines added in a PR may not cite ticket
 * numbers (`#1234`), planning ids (`P1-W02a`) or "owner decision". Only added
 * lines are checked, so existing comments never block an unrelated PR.
 *
 * Usage: tsx scripts/ci/check-comment-archaeology.ts <base-ref>
 */
import { execFileSync } from "node:child_process";

const SELF = "scripts/ci/check-comment-archaeology.ts";
const BANNED = /#\d{3,5}\b|\bP\d-W\d+[a-z]?\b|owner decision/i;

const base = process.argv[2];
if (!base) {
  console.log("No base ref given; nothing to compare.");
  process.exit(0);
}

const diff = execFileSync(
  "git",
  [
    "diff",
    "-U0",
    "--no-color",
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

/** The comment part of a code line, or null when the line has none. */
function commentOf(line: string): string | null {
  const slashes = line.search(/(?<!:)\/\//);
  const block = line.search(/\/\*|^\s*\*/);
  const dashes = line.search(/(^|\s)--\s/);
  const starts = [slashes, block, dashes].filter((i) => i !== -1);
  return starts.length > 0 ? line.slice(Math.min(...starts)) : null;
}

const violations: string[] = [];
let file = "";
let lineNo = 0;
for (const row of diff.split("\n")) {
  if (row.startsWith("+++ ")) {
    file = row.slice(6);
    continue;
  }
  const hunk = row.match(/^@@ -\S+ \+(\d+)/);
  if (hunk) {
    lineNo = Number(hunk[1]);
    continue;
  }
  if (!row.startsWith("+") || row.startsWith("+++")) continue;
  const current = lineNo++;
  if (file === SELF) continue;
  const comment = commentOf(row.slice(1));
  if (comment !== null && BANNED.test(comment)) {
    violations.push(`${file}:${current}: ${comment.trim()}`);
  }
}

if (violations.length > 0) {
  console.error(
    "Comments may state only the current invariant (AGENTS.md §1.5). Remove the ticket or planning reference:\n",
  );
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Comment archaeology guard: clean.");
