/**
 * CI guard: the committed schema map must match the schema.
 *
 * `docs/prisma/00-schema-map.md` used to be hand-drawn, and it drifted: the
 * file described 120 models while the schema had grown past 160, ten of the
 * model names in its diagrams no longer existed, and the enforcers in
 * `prisma/sql/` appeared nowhere. Nothing caught that, because a
 * documentation file cannot disagree with code in a way a compiler notices.
 *
 * This check regenerates the map from `prisma/schema.prisma` and compares it
 * to the committed copy. A schema change that forgot its diagram fails here
 * rather than in a reader's head.
 *
 * The map is several files — an index plus one part per topic — so every one
 * of them is compared, and a part file the split no longer produces is
 * reported as an orphan.
 *
 * Static only: no network, no database.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSchemaMap, DOMAINS_DIR } from "../prisma/build-schema-map";

const ROOT = path.resolve(__dirname, "..", "..");

async function main(): Promise<number> {
  let files: Array<{ path: string; content: string }>;
  try {
    files = await buildSchemaMap();
  } catch (error) {
    console.error(
      `::error::schema map could not be generated: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const stale: string[] = [];
  for (const f of files) {
    const abs = path.join(ROOT, f.path);
    if (!fs.existsSync(abs)) {
      stale.push(`${f.path} (missing)`);
      continue;
    }
    if (fs.readFileSync(abs, "utf8") !== f.content) stale.push(f.path);
  }

  const expected = new Set(files.map((f) => path.join(ROOT, f.path)));
  const orphans: string[] = [];
  if (fs.existsSync(DOMAINS_DIR)) {
    for (const name of fs.readdirSync(DOMAINS_DIR)) {
      const abs = path.join(DOMAINS_DIR, name);
      if (!expected.has(abs)) orphans.push(path.relative(ROOT, abs));
    }
  }

  if (stale.length || orphans.length) {
    if (stale.length) {
      console.error(
        `::error::the schema map has drifted from prisma/schema.prisma: ${stale.join(", ")}. ` +
          `Run: npm run docs:schema-map  (and commit the result)`,
      );
    }
    if (orphans.length) {
      console.error(
        `::error::orphaned schema-map part files: ${orphans.join(", ")}. ` +
          `Run: npm run docs:schema-map  (and commit the result)`,
      );
    }
    return 1;
  }

  console.log(
    `schema map matches prisma/schema.prisma (${files.length} files)`,
  );
  return 0;
}

void main().then((code) => process.exit(code));
