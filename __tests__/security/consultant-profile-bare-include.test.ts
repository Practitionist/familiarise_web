/**
 * @jest-environment node
 */

/**
 * ConsultantProfile carries PAN, bank and TDS columns. `consultantProfile: true`
 * or a nested `include` fetches all of them; routes must `select` an allowlist.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const API_DIR = path.join(ROOT, "app", "api");

const BARE_INCLUDE = [
  /consultantProfile\s*:\s*true\b/g,
  /consultantProfile\s*:\s*\{\s*include\s*:/g,
];

// Bare sites still allowed, by file. Both files are being rewritten elsewhere;
// delete an entry when its file no longer has any.
const KNOWN_BARE_SITES: Record<string, number> = {
  "app/api/appointments/[appointmentId]/documents/route.ts": 4,
  "app/api/dashboard/consultee/[consulteeId]/resources/route.ts": 7,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
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

describe("consultant profile bare includes under app/api", () => {
  it("matches the reviewed list exactly", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(API_DIR)) {
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
