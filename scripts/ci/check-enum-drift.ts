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
 * Direction matters, and only one direction is a fault:
 *
 *   - DB has a label the schema lacks   → BREAKS the client. This is the check.
 *   - Schema has a label the DB lacks   → harmless; the DB simply has not been
 *     pushed yet, and nothing can be reading a value that does not exist.
 *
 * So this compares labels only, and only flags the first case. It does NOT
 * check whether rows still use a dropped label — dropping a label from the
 * schema while rows hold it is exactly the failure above, and this fires before
 * the enum can be dropped from the database at all.
 *
 * Requires DATABASE_URL. Skips cleanly when absent so local runs and forked PRs
 * without secrets do not fail on a check they cannot perform.
 */
import fs from "fs";
import path from "path";

// The repo's configured singleton, not a hand-rolled client: Prisma 7 needs an
// explicit adapter (`lib/prisma.ts` builds a PrismaPg one), and every other
// connecting script under scripts/ imports this same instance.
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

type DbEnum = { enum_name: string; enum_value: string };
type EnumColumn = {
  table_name: string;
  column_name: string;
  enum_name: string;
};

function schemaEnums(): Map<string, Set<string>> {
  const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
  const schema = fs.readFileSync(schemaPath, "utf8");

  const out = new Map<string, Set<string>>();
  const enumRe = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = enumRe.exec(schema))) {
    const [, name, body] = m;
    const values = new Set<string>();
    for (const raw of body.split("\n")) {
      // Strip trailing `// comment` and doc lines, then take the bare label.
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const value = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
      if (value) values.add(value[1]);
    }
    out.set(name, values);
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("enum-drift: DATABASE_URL not set — skipping.");
    return;
  }

  const declared = schemaEnums();

  try {
    // Raw SQL because this asks about the database's own catalog, which the
    // generated client has no view of by construction.
    const dbEnums = await prisma.$queryRaw<DbEnum[]>`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
    `;

    const byEnum = new Map<string, string[]>();
    for (const { enum_name, enum_value } of dbEnums) {
      byEnum.set(enum_name, [...(byEnum.get(enum_name) ?? []), enum_value]);
    }

    // Labels the database has and the schema does not. On their own these are
    // INERT — Prisma only throws when it reads a ROW holding one. Reported as a
    // warning so the divergence stays visible, because Postgres cannot drop an
    // enum value in place: clearing it means recreating the type across every
    // column that uses it, which is a `db push` rather than a code change.
    const staleLabels: string[] = [];
    for (const [name, dbValues] of byEnum) {
      const schemaValues = declared.get(name);
      // An enum the schema does not model may belong to an extension.
      if (!schemaValues) continue;
      const extra = dbValues.filter((v) => !schemaValues.has(v));
      if (extra.length > 0) staleLabels.push(`  - ${name}: ${extra.join(", ")}`);
    }

    // What actually breaks: a ROW holding a value the client cannot parse.
    // Found by asking the catalog which columns carry which enum, then counting
    // rows outside the declared set — no hardcoded table list to go stale.
    const columns = await prisma.$queryRaw<EnumColumn[]>`
      SELECT c.table_name, c.column_name, c.udt_name AS enum_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.udt_name IN (${Prisma.join([...declared.keys()])})
    `;

    const breaking: string[] = [];
    for (const col of columns) {
      const allowed = declared.get(col.enum_name);
      if (!allowed || allowed.size === 0) continue;
      const rows = await prisma.$queryRawUnsafe<{ value: string; n: bigint }[]>(
        `SELECT "${col.column_name}"::text AS value, COUNT(*) AS n
           FROM "${col.table_name}"
          WHERE "${col.column_name}"::text <> ALL($1::text[])
          GROUP BY 1`,
        [...allowed],
      );
      for (const r of rows) {
        breaking.push(
          `  - ${col.table_name}.${col.column_name} = ${r.value} (${r.n} rows)`,
        );
      }
    }

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
      process.exit(1);
    }

    console.log(
      `enum-drift: no unparseable rows — ${columns.length} enum columns checked.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("enum-drift: check failed to run:", err);
  process.exit(1);
});
