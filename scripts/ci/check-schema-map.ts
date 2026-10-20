/**
 * CI guard: the committed schema map must match the schema.
 *
 * `docs/prisma/00-schema-map.md` used to be hand-drawn, and it drifted: the
 * file described 120 models while the schema had grown past 160, and ten of
 * the model names in its diagrams no longer existed. Nothing caught that,
 * because a documentation file cannot disagree with code in a way a compiler
 * notices.
 *
 * This check regenerates the map from `prisma/schema.prisma` and compares it
 * to the committed copy. A schema change that forgot its diagram fails here
 * rather than in a reader's head.
 *
 * Static only: no network, no database.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSchemaMap, OUT_PATH } from "../prisma/build-schema-map";

const ROOT = path.resolve(__dirname, "..", "..");

function main(): number {
  let generated: string;
  try {
    generated = buildSchemaMap();
  } catch (error) {
    console.error(
      `::error::schema map could not be generated: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const rel = path.relative(ROOT, OUT_PATH);
  if (!fs.existsSync(OUT_PATH)) {
    console.error(`::error::${rel} is missing. Run: npm run docs:schema-map`);
    return 1;
  }

  const committed = fs.readFileSync(OUT_PATH, "utf8");
  if (committed === generated) {
    console.log(`schema map matches prisma/schema.prisma (${rel})`);
    return 0;
  }

  console.error(
    `::error::${rel} has drifted from prisma/schema.prisma. ` +
      `Run: npm run docs:schema-map  (and commit the result)`,
  );
  return 1;
}

process.exit(main());
