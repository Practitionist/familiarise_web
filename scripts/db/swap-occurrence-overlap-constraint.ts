/**
 * #1694 — swap `occurrence_no_confirmed_overlap` to its tombstone-exempt shape
 * on a LIVE database, without ever leaving the table unguarded.
 *
 * Postgres cannot attach an EXCLUDE constraint to a pre-built index (only
 * UNIQUE / PRIMARY KEY accept `USING INDEX`), so the constraint's own GiST
 * index is built inside the swap. The script keeps that window safe in three
 * steps, each its own invocation so the operator reads the answer between them:
 *
 *   --verify   Read-only. Confirms btree_gist, prints the current definition,
 *              and lists every live overlapping pair the NEW predicate would
 *              reject (there must be none, or the ADD fails and rolls back).
 *   --shadow   `CREATE INDEX CONCURRENTLY` a partial GiST index with the new
 *              predicate. It takes no exclusive lock, proves the predicate and
 *              the operator classes compile against real rows, and warms the
 *              pages the constraint build reads. Dropped again by --swap.
 *   --swap     ONE transaction, `lock_timeout` 5 s: DROP the old constraint,
 *              ADD the new one, DROP the shadow index. Atomic — the table is
 *              never without the backstop — and it fails fast rather than
 *              queueing behind a long reader (an ACCESS EXCLUSIVE wait blocks
 *              every later query on the table in FIFO order).
 *
 * Run after `--swap`: `npm run db:assert-sidecars`. Owner-gated: the shared
 * Supabase project serves dev AND prod, so this is a production operation.
 *
 * Usage: npx tsx -r dotenv/config scripts/db/swap-occurrence-overlap-constraint.ts --verify
 */
import prisma from "../../lib/prisma";

const CONSTRAINT = "occurrence_no_confirmed_overlap";
const SHADOW_INDEX = "occurrence_no_confirmed_overlap_shadow_1694";
const NEW_PREDICATE =
  '("consultantProfileId" IS NOT NULL AND NOT "isTentative" AND "deletedAt" IS NULL)';

interface OverlapPair {
  a: string;
  b: string;
  consultantProfileId: string;
}

async function verify(): Promise<boolean> {
  const ext = await prisma.$queryRaw<{ extname: string }[]>`
    SELECT extname FROM pg_extension WHERE extname = 'btree_gist'
  `;
  console.log(`btree_gist: ${ext.length ? "present" : "MISSING"}`);

  const def = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${CONSTRAINT}
  `;
  console.log(`current definition: ${def[0]?.def ?? "(absent)"}`);

  // Every pair the new predicate would still forbid. A non-empty answer means
  // a confirmed double-book already exists and must be resolved by hand first.
  const pairs = await prisma.$queryRaw<OverlapPair[]>`
    SELECT a.id AS a, b.id AS b, a."consultantProfileId"
      FROM "AppointmentOccurrence" a
      JOIN "AppointmentOccurrence" b
        ON b."consultantProfileId" = a."consultantProfileId"
       AND b.id > a.id
       AND tstzrange(a."startsAt", a."endsAt") && tstzrange(b."startsAt", b."endsAt")
     WHERE a."consultantProfileId" IS NOT NULL AND NOT a."isTentative" AND a."deletedAt" IS NULL
       AND b."consultantProfileId" IS NOT NULL AND NOT b."isTentative" AND b."deletedAt" IS NULL
  `;
  console.log(
    `live overlapping pairs under the new predicate: ${pairs.length}`,
  );
  for (const p of pairs)
    console.log(`  ${p.consultantProfileId}: ${p.a} <> ${p.b}`);

  const alreadySwapped = def[0]?.def.includes('"deletedAt" IS NULL') ?? false;
  console.log(alreadySwapped ? "already swapped" : "swap pending");
  return ext.length > 0 && pairs.length === 0;
}

async function shadow(): Promise<void> {
  // CONCURRENTLY cannot run inside a transaction, so this is a bare statement.
  await prisma.$executeRawUnsafe(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SHADOW_INDEX}"
       ON "AppointmentOccurrence" USING gist ("consultantProfileId", tstzrange("startsAt", "endsAt"))
       WHERE ${NEW_PREDICATE}`,
  );
  const valid = await prisma.$queryRaw<{ indisvalid: boolean }[]>`
    SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${SHADOW_INDEX}
  `;
  console.log(`shadow index valid: ${valid[0]?.indisvalid ?? false}`);
}

async function swap(): Promise<void> {
  if (!(await verify())) {
    throw new Error(
      "verify failed — resolve the findings above before swapping",
    );
  }
  await prisma.$transaction([
    prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'"),
    prisma.$executeRawUnsafe(
      `ALTER TABLE "AppointmentOccurrence" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`,
    ),
    prisma.$executeRawUnsafe(
      `ALTER TABLE "AppointmentOccurrence" ADD CONSTRAINT "${CONSTRAINT}"
         EXCLUDE USING gist ("consultantProfileId" WITH =, tstzrange("startsAt", "endsAt") WITH &&)
         WHERE ${NEW_PREDICATE}`,
    ),
    prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${SHADOW_INDEX}"`),
  ]);
  const def = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${CONSTRAINT}
  `;
  console.log(`new definition: ${def[0]?.def ?? "(absent)"}`);
}

// A constant label, never a value derived from the connection string, so the
// log names the target without echoing any part of the secret (Sonar S8689).
const KNOWN_DATABASE_HOSTS: Record<string, string> = {
  "db.pzmbxqdgibfkhjwzeprf.supabase.co": "familiarise (SHARED dev + prod)",
};

function describeTargetDatabase(databaseUrl: string): string {
  const label = KNOWN_DATABASE_HOSTS[new URL(databaseUrl).host];
  return label ?? "UNRECOGNISED host — check DATABASE_URL before continuing";
}

async function main(): Promise<void> {
  // One Supabase project serves dev AND prod, so the operator must see the
  // target before any statement runs.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is not set — refusing to run");
  console.log(`target database: ${describeTargetDatabase(databaseUrl)}`);
  const mode = process.argv.find((a) => a.startsWith("--")) ?? "--verify";
  switch (mode) {
    case "--verify":
      await verify();
      return;
    case "--shadow":
      await shadow();
      return;
    case "--swap":
      await swap();
      return;
    default:
      throw new Error(`unknown mode ${mode}; use --verify, --shadow or --swap`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌", err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
