/**
 * @jest-environment node
 */

/**
 * ConsultantProfile carries PAN, bank and TDS columns. `consultantProfile: true`
 * or a nested `include` fetches all of them, as does selecting the full `user`
 * row under it; queries must `select` an allowlist.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = [
  "app/api",
  "lib/data",
  "lib/collaborators",
  "lib/api",
  "utils",
];

const BARE_INCLUDE = [
  /consultantProfile\s*:\s*true\b/g,
  /consultantProfile\s*:\s*\{\s*include\s*:/g,
  /consultantProfile\s*:\s*\{\s*(?:select|include)\s*:\s*\{[^{}]*\buser\s*:\s*true\b/g,
];

// Bare sites still allowed, as file path to count. None are.
const KNOWN_BARE_SITES: Record<string, number> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__tests__"
        ? []
        : sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

// Comments quote the anti-pattern, and zod `.omit({ consultantProfile: true })`
// is a schema key rather than a query.
function queryText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\.(omit|pick)\(\{[^}]*\}\)/g, "");
}

describe("consultant profile bare includes", () => {
  it("matches the reviewed list exactly", () => {
    const found: Record<string, number> = {};
    for (const file of SCAN_ROOTS.flatMap((dir) =>
      sourceFiles(path.join(ROOT, dir)),
    )) {
      const text = queryText(readFileSync(file, "utf8"));
      const sites = BARE_INCLUDE.reduce(
        (count, pattern) => count + (text.match(pattern)?.length ?? 0),
        0,
      );
      if (sites > 0) {
        found[path.relative(ROOT, file).split(path.sep).join("/")] = sites;
      }
    }

    expect(found).toEqual(KNOWN_BARE_SITES);
  });
});
