/**
 * CI guard — every enum value in the DATABASE must be declared in
 * `schema.prisma`.
 *
 * Prisma's client rejects any row whose enum value it does not know, and the
 * error names the value rather than the cause: "Value 'LEMON_SQUEEZY' not found
 * in enum 'PaymentGateway'". It surfaces wherever a query happens to touch such
 * a row, which is rarely where the mistake was made.
 *
 * That happened on 2026-07-12: `183d0e72` deliberately removed LEMON_SQUEEZY
 * and XFLOW from `PaymentGateway` along with the Lemon Squeezy webhook, but the
 * 187 existing rows using them were never migrated. It went unnoticed for 16
 * days, then showed up as a failing `cleanup-abandoned-payments` cron and a
 * dead back-office payments dashboard — `getOperatorStats` groups by
 * `paymentGateway` inside a `Promise.all`, so one unknown value took the whole
 * stats read down, not just the gateway breakdown.
 *
 * Two directions, only one of which is a fault:
 *
 *   - A ROW holds a value the schema lacks → BREAKS the client. Fails the build.
 *   - The DB declares a LABEL the schema lacks → inert until a row uses it, and
 *     Postgres cannot drop an enum value in place, so clearing it means
 *     recreating the type across every column that uses it. Warns only; failing
 *     here would red-light CI on a condition no code change can resolve.
 *
 * Plain `.mjs` on `pg` rather than TypeScript on the Prisma client, for two
 * reasons. A TS runner would have to be fetched or added as a dependency, and
 * the whole point of this check is that it must not itself perturb the build.
 * And the Prisma client is the wrong instrument regardless: it refuses to read
 * the very rows this looks for, and knows nothing of the catalog it queries.
 *
 * Requires DATABASE_URL. Skips cleanly when absent so local runs and forked PRs
 * without secrets do not fail on a check they cannot perform.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Labels declared per enum in schema.prisma. */
function schemaEnums() {
  const schemaPath = path.join(
    __dirname,
    "..",
    "..",
    "prisma",
    "schema.prisma",
  );
  const schema = fs.readFileSync(schemaPath, "utf8");

  const out = new Map();
  const enumRe = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = enumRe.exec(schema))) {
    const [, name, body] = m;
    const values = new Set();
    for (const raw of body.split("\n")) {
      // Strip trailing `// comment` and `///` doc lines, then take the bare
      // label. indexOf rather than a regex: the label pattern below is the only
      // thing that needs to be exact, and a scan for two characters cannot
      // backtrack.
      const comment = raw.indexOf("//");
      const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
      if (!line || line.startsWith("@@")) continue;
      const value = /^([A-Za-z_]\w*)$/.exec(line);
      if (value) values.add(value[1]);
    }
    out.set(name, values);
  }
  return out;
}

/** Postgres identifier quoting — catalog-sourced, but never interpolate raw. */
function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Labels the database declares that schema.prisma does not. Inert, warn-only. */
async function findStaleLabels(client, declared) {
  const { rows } = await client.query(
    `SELECT t.typname AS enum_name, e.enumlabel AS enum_value
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'`,
  );

  const byEnum = new Map();
  for (const { enum_name, enum_value } of rows) {
    if (!byEnum.has(enum_name)) byEnum.set(enum_name, []);
    byEnum.get(enum_name).push(enum_value);
  }

  const stale = [];
  for (const [name, dbValues] of byEnum) {
    // An enum the schema does not model may belong to an extension.
    const schemaValues = declared.get(name);
    if (!schemaValues) continue;
    const extra = dbValues.filter((v) => !schemaValues.has(v));
    if (extra.length > 0) stale.push(`  - ${name}: ${extra.join(", ")}`);
  }
  return stale;
}

/**
 * What actually breaks: a ROW holding a value the client cannot parse. Found by
 * asking the catalog which columns carry which enum, then counting rows outside
 * the declared set — no hardcoded table list to go stale.
 */
async function findBreakingRows(client, declared) {
  const { rows: columns } = await client.query(
    `SELECT c.table_name, c.column_name, c.udt_name AS enum_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.udt_name = ANY($1::text[])`,
    [[...declared.keys()]],
  );

  const breaking = [];
  for (const col of columns) {
    const allowed = declared.get(col.enum_name);
    if (!allowed || allowed.size === 0) continue;
    const { rows } = await client.query(
      `SELECT ${quoteIdent(col.column_name)}::text AS value, COUNT(*) AS n
         FROM ${quoteIdent(col.table_name)}
        WHERE ${quoteIdent(col.column_name)}::text <> ALL($1::text[])
        GROUP BY 1`,
      [[...allowed]],
    );
    for (const r of rows) {
      breaking.push(
        `  - ${col.table_name}.${col.column_name} = ${r.value} (${r.n} rows)`,
      );
    }
  }
  return { breaking, columnCount: columns.length };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("enum-drift: DATABASE_URL not set — skipping.");
    return;
  }

  const declared = schemaEnums();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const staleLabels = await findStaleLabels(client, declared);
    const { breaking, columnCount } = await findBreakingRows(client, declared);

    if (staleLabels.length > 0) {
      console.warn(
        "enum-drift WARNING — database declares labels schema.prisma does not:\n" +
          staleLabels.join("\n") +
          "\n  Inert while unused; clear them on the next db push.\n",
      );
    }

    if (breaking.length > 0) {
      console.error(
        "enum-drift FAILURE — rows hold values Prisma cannot parse:\n" +
          breaking.join("\n") +
          "\n\nEvery read touching these rows throws, wherever it happens.\n" +
          "Migrate the rows to a declared value; do not add the values back\n" +
          "unless they are genuinely supported again.",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `enum-drift: no unparseable rows — ${columnCount} enum columns checked.`,
    );
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (err) {
  console.error("enum-drift: check failed to run:", err);
  process.exitCode = 1;
}
