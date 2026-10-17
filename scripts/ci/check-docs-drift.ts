/**
 * CI guard: documentation must not point at things that do not exist.
 *
 * Three rules over every Markdown file in `docs/` and `.claude/skills/`:
 *   1. A backticked repo path (`lib/foo.ts`, `app/api/x/route.ts`) exists.
 *   2. A relative Markdown link resolves to a file or directory.
 *   3. No `docs/start-here/` file cites a line number (`file.ts:123`).
 *
 * Warn-only until the existing docs are clean: it prints GitHub warning
 * annotations and exits 0. Pass `--strict` to exit 1 on any finding.
 * Static only: no network, no database.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const SCAN_DIRS = ["docs", path.join(".claude", "skills")];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);

type Finding = {
  file: string;
  line: number;
  rule: "missing-path" | "broken-link" | "line-number";
  message: string;
};

function listMarkdown(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/** Top-level repo directories; a backticked token is a repo path only if it starts with one. */
function topLevelDirs(): Set<string> {
  return new Set(
    fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => e.name),
  );
}

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ line: i + 1, text: raw });
  });
  return out;
}

/** A cited module may omit its extension (`lib/payments/ledger/post`). */
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", "/index.ts"];
const PLACEHOLDER = /[*<>{}$]|\.\.\./;
const BACKTICK_PATH = /`([A-Za-z0-9_.@[\]/-]+\/[A-Za-z0-9_.@[\]-]+)`/g;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_REF = /[\w.[\]/-]+\.(?:ts|tsx|mts|js|mjs|sql|prisma):\d+/;

function checkFile(
  file: string,
  text: string,
  roots: Set<string>,
  exists: (p: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const dir = path.dirname(file);
  const startHere = file
    .split(path.sep)
    .join("/")
    .startsWith("docs/start-here/");

  for (const { line, text: l } of proseLines(text)) {
    for (const m of l.matchAll(BACKTICK_PATH)) {
      const token = m[1]
        .replace(/^@\//, "")
        .replace(/:\d+(-\d+)?$/, "")
        .replace(/#.*$/, "");
      const first = token.split("/")[0];
      if (!roots.has(first) || PLACEHOLDER.test(token)) continue;
      if (!MODULE_SUFFIXES.some((suffix) => exists(token + suffix))) {
        findings.push({
          file,
          line,
          rule: "missing-path",
          message: `cited path does not exist: ${token}`,
        });
      }
    }

    for (const m of l.matchAll(MD_LINK)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target) || PLACEHOLDER.test(target)) {
        continue;
      }
      const bare = decodeURI(target.replace(/[#?].*$/, ""));
      if (bare === "") continue;
      const resolved = bare.startsWith("/")
        ? bare.slice(1)
        : path.normalize(path.join(dir, bare));
      if (!exists(resolved)) {
        findings.push({
          file,
          line,
          rule: "broken-link",
          message: `link does not resolve: ${target}`,
        });
      }
    }

    if (startHere) {
      const ref = LINE_REF.exec(l);
      if (ref) {
        findings.push({
          file,
          line,
          rule: "line-number",
          message: `start-here docs cite files and functions, not line numbers: ${ref[0]}`,
        });
      }
    }
  }
  return findings;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const roots = topLevelDirs();
  const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
  const files = SCAN_DIRS.flatMap(listMarkdown);

  const findings = files.flatMap((file) =>
    checkFile(
      file,
      fs.readFileSync(path.join(ROOT, file), "utf8"),
      roots,
      exists,
    ),
  );

  for (const f of findings) {
    console.log(
      `::warning file=${f.file},line=${f.line},title=docs-drift ${f.rule}::${f.message}`,
    );
  }

  const byRule = (rule: Finding["rule"]) =>
    findings.filter((f) => f.rule === rule).length;
  console.log(
    `check-docs-drift: ${files.length} files, ${findings.length} findings ` +
      `(${byRule("missing-path")} missing paths, ${byRule("broken-link")} broken links, ` +
      `${byRule("line-number")} start-here line numbers)`,
  );

  if (strict && findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && /check-docs-drift/.test(process.argv[1])) {
  main();
}
