/**
 * Re-encrypt every `SsoProvider` config column from plaintext JSON into the
 * `sso:v1:` envelope (`lib/sso/secret-crypto.ts`).
 *
 * Not a backfill migration and not a schema migration: it touches no DDL,
 * nothing in the schema depends on it having run, and it is idempotent — a
 * row that is already an envelope is skipped, so re-running is free. Until it
 * runs, every row is plaintext, which is the state the create route has
 * always written and which `decryptSecretPayload` passes through unchanged.
 *
 * ## This script needs a RAW Prisma client, and gets its own
 *
 * `lib/prisma.ts` exports a client carrying the `$extends({ result })` map
 * from `lib/prisma-sso-secret-extension.ts`, which decrypts and parses both
 * config columns on read. That is exactly right for application code and
 * exactly wrong here: this job's entire job is to inspect the *stored bytes*
 * to decide whether a row needs converting. Against the extended client,
 *
 *   - `isEncrypted(stored)` is always false, because the value is an object
 *     and `isEncrypted` is a `startsWith` on a string, so every row looks
 *     plaintext;
 *   - `decryptSecretPayload(stored)` then runs `JSON.parse` on an object,
 *     which stringifies it to `"[object Object]"` and throws — so the run
 *     would abort having done nothing.
 *
 * Failing loudly is the good outcome. The dangerous one is the version that
 * reads the extended client and writes `encryptSecretPayload` over whatever it
 * got: that is a decrypt-then-re-encrypt of a value that is already
 * plaintext, which happens to produce a *correct* envelope — but it also
 * means the "already encrypted, skip" idempotency check can never fire, so
 * every run rewrites every row forever.
 *
 * `lib/prisma.ts` does not export an unextended client (`makeClient` is
 * private, and only the extended default export leaves the module), and that
 * file is owned elsewhere, so this script constructs its own `PrismaClient`
 * directly. That is the honest way to express the requirement rather than
 * reaching into a module for something it deliberately does not export.
 *
 * The connection is configured independently, and the timeouts differ on
 * purpose: `lib/prisma.ts` budgets ~3s to connect so a saturated pooler
 * cannot eat a serverless function's ceiling, which is the wrong trade for a
 * batch job that can afford to wait. `assertRawColumns` below then proves at
 * runtime that the read really is raw, so a future edit that re-points the
 * import at `lib/prisma` fails immediately with a clear reason instead of
 * half-converting the table.
 *
 * ## Gating
 *
 * Writes are refused unless `SSO_CONFIG_ENCRYPTION_ENABLED` is `true`, which
 * is the same flag the create route gates on. The reason the flag exists is
 * rollback safety, not read safety — see the "Why the WRITE stays flag-gated"
 * section of `lib/sso/secret-crypto.ts`. Turning it on and turning on the
 * Prisma decrypt extension belong in the same deploy.
 *
 * `--dry-run` needs no flag and is always safe: it reads and reports without
 * writing. It is also the way to confirm the mounted `AUTH_CONFIG_ENCRYPTION_KEY`
 * can read every existing row before committing to a rewrite, which is the
 * order that matters: a key that cannot read the table cannot rewrite it.
 *
 * ## Failure handling
 *
 * Per row, and deliberately not per batch: one unreadable row must not stop
 * the sweep, because the remaining rows are the ones that can be converted
 * today. A row that fails is reported with its id, its org and the
 * `SecretPayloadError.failure` reason, the run exits non-zero, and the row is
 * left exactly as it was. Nothing here can make a row unreadable that was not
 * already unreadable, and nothing here writes unless the row was read
 * successfully in this same run.
 *
 * Usage: `npx tsx -r dotenv/config scripts/encrypt-sso-secrets.ts --dry-run`
 *        `npx tsx -r dotenv/config scripts/encrypt-sso-secrets.ts`
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  decryptSecretPayload,
  encryptSecretPayload,
  isEncrypted,
  isSecretEncryptionEnabled,
  SecretPayloadError,
} from "../lib/sso/secret-crypto";

/**
 * A deliberately unextended client — see the module header.
 *
 * The `PrismaPg` config is intentionally *not* copied from `lib/prisma.ts`:
 * that file's ~3s connect budget exists to stop a saturated pooler from
 * eating a Netlify function's ceiling, and this is a batch job with no
 * function ceiling. A minute of patience is the right trade here.
 */
const rawPrisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 60_000,
  }),
});

interface ColumnSpec {
  column: "oidcConfig" | "samlConfig";
  label: string;
}

const COLUMNS: readonly ColumnSpec[] = [
  { column: "oidcConfig", label: "OIDC" },
  { column: "samlConfig", label: "SAML" },
];

interface RowFailure {
  providerId: string;
  organizationId: string | null;
  column: string;
  failure: string;
}

/**
 * Fail before writing anything if the read is not actually raw.
 *
 * A runtime proof rather than a comment, because the failure it guards
 * against is silent: a client that decrypts on read hands back objects, and
 * this script's first move is `isEncrypted(value)` on a value it assumes is a
 * string. Without this check the mistake surfaces as a table of
 * `payload_not_json` failures that reads like data corruption and invites
 * someone to go looking for a bad key that does not exist.
 */
function assertRawColumns(
  providers: { providerId: string; column: string; columnValue: unknown }[],
): void {
  const decrypted = providers.find(
    ({ columnValue }) => columnValue !== null && typeof columnValue !== "string",
  );
  if (!decrypted) return;
  throw new Error(
    `Refusing to run: ${decrypted.providerId}.${decrypted.column} came back as ` +
      `${typeof decrypted.columnValue}, not a string. This means the read went through ` +
      "a Prisma client carrying the ssoProvider result extension, which decrypts the " +
      "column before returning it. This job must see the raw stored bytes so it can " +
      "tell an sso:v1: envelope from legacy plaintext JSON. Construct the client with " +
      "`new PrismaClient({ adapter })` and do NOT import it from lib/prisma.",
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (!dryRun && !isSecretEncryptionEnabled()) {
    console.error(
      "❌ Refusing to write.\n" +
        "   SSO_CONFIG_ENCRYPTION_ENABLED is not set to \"true\".\n" +
        "   Writing envelopes into SsoProvider.oidcConfig / .samlConfig is only\n" +
        "   reversible if every build that could later read the table can also read\n" +
        "   envelopes. Turning the flag on and shipping the Prisma decrypt extension\n" +
        "   (lib/prisma-sso-secret-extension.ts) must be the same deploy.\n" +
        "   Run with --dry-run to see what would change.",
    );
    process.exit(1);
  }

  const providers = await rawPrisma.ssoProvider.findMany({
    select: {
      id: true,
      providerId: true,
      organizationId: true,
      oidcConfig: true,
      samlConfig: true,
    },
  });

  assertRawColumns(
    providers.flatMap((provider) =>
      COLUMNS.map(({ column, label }) => ({
        providerId: provider.providerId,
        column: label,
        columnValue: provider[column],
      })),
    ),
  );

  let reEncrypted = 0;
  let alreadyEncrypted = 0;
  let empty = 0;
  const failures: RowFailure[] = [];

  console.log(
    `🔐 SSO secret re-encryption — ${dryRun ? "DRY RUN" : "LIVE"}\n` +
      `   Providers: ${providers.length}\n` +
      `   Mode: ${dryRun ? "report only" : "SSO_CONFIG_ENCRYPTION_ENABLED=true"}`,
  );

  for (const provider of providers) {
    for (const { column, label } of COLUMNS) {
      const stored = provider[column];
      if (!stored) {
        empty += 1;
        continue;
      }
      // Meaningful only against a raw read — which `assertRawColumns` has
      // just confirmed it is. This is what makes a re-run free.
      if (isEncrypted(stored)) {
        alreadyEncrypted += 1;
        continue;
      }

      let payload: unknown;
      try {
        // Passing through `decryptSecretPayload` rather than `JSON.parse`
        // means a row that is structurally an envelope but will not decrypt,
        // or one holding corrupt non-JSON, fails here with a named reason
        // instead of writing `undefined` over a working config.
        payload = decryptSecretPayload(stored);
      } catch (err) {
        failures.push({
          providerId: provider.providerId,
          organizationId: provider.organizationId,
          column: label,
          failure:
            err instanceof SecretPayloadError ? err.failure : "unexpected_error",
        });
        continue;
      }

      if (payload === null || typeof payload !== "object") {
        // A column that parses to `null` or to a bare scalar is not a config.
        // Encrypting it would be indistinguishable from valid JSON to every
        // reader, so it is left alone and reported instead.
        failures.push({
          providerId: provider.providerId,
          organizationId: provider.organizationId,
          column: label,
          failure: "unexpected_null_payload",
        });
        continue;
      }

      if (dryRun) {
        console.log(
          `   ↻ would re-encrypt ${provider.providerId} (${label})` +
            `${provider.organizationId ? ` org=${provider.organizationId}` : ""}`,
        );
        reEncrypted += 1;
        continue;
      }

      try {
        await rawPrisma.ssoProvider.update({
          where: { id: provider.id },
          data: { [column]: encryptSecretPayload(payload) },
        });
        reEncrypted += 1;
        console.log(
          `   ✅ re-encrypted ${provider.providerId} (${label})` +
            `${provider.organizationId ? ` org=${provider.organizationId}` : ""}`,
        );
      } catch (err) {
        failures.push({
          providerId: provider.providerId,
          organizationId: provider.organizationId,
          column: label,
          failure: err instanceof Error ? err.name : "update_failed",
        });
      }
    }
  }

  console.log(
    `\n📊 ${JSON.stringify({
      event: dryRun
        ? "sso_secret_encrypt_dry_run"
        : "sso_secret_encrypt_complete",
      providers: providers.length,
      reEncrypted,
      alreadyEncrypted,
      empty,
      failed: failures.length,
    })}`,
  );

  if (failures.length > 0) {
    // Grouped by reason so the operator can tell "one key mismatch" from
    // "one genuinely corrupt row" without reading every line.
    const byFailure = new Map<string, RowFailure[]>();
    for (const failure of failures) {
      const bucket = byFailure.get(failure.failure) ?? [];
      bucket.push(failure);
      byFailure.set(failure.failure, bucket);
    }
    for (const [reason, rows] of byFailure) {
      console.error(`\n❌ ${reason} — ${rows.length} column(s) left unchanged:`);
      for (const row of rows) {
        console.error(
          `   ${row.providerId} [${row.column}]` +
            `${row.organizationId ? ` org=${row.organizationId}` : " org=(none)"}`,
        );
      }
    }
    console.error(
      "\n   A `key_unavailable` result means AUTH_CONFIG_ENCRYPTION_KEY is not\n" +
        "   mounted, or is not 64 hex characters. Nothing was modified for those\n" +
        "   rows. Re-run with --dry-run after fixing the key.",
    );
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => rawPrisma.$disconnect());
