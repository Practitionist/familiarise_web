#!/usr/bin/env npx tsx
/**
 * Backfill `SsoProvider.samlConfig` from the shape the create route used to
 * write (`{issuer, entryPoint, cert}`) to the shape
 * `buildStoredSamlConfig` produces today.
 *
 * ## Why this exists
 *
 * `lib/sso/stored-config.ts` documents the defect in full, so this file does
 * not restate it — only the operational half. `buildStoredSamlConfig` fixes
 * every *new* registration. It does not touch rows already in the table, and
 * a shape change that fixes nothing on its own is the worst kind: the code
 * now claims a guarantee the data does not have. Until this runs, every SAML
 * provider this app has ever registered still 500s with an empty body on
 * sign-in (`TypeError: Cannot read properties of undefined (reading
 * 'metadata')` at `@better-auth/sso@1.6.5` `dist/index.mjs:2447` / `:1851`).
 * So this is a **data** backfill, not a migration — there is no DDL, nothing
 * in the schema depends on it having run, and it is safe to re-run forever.
 *
 * ## Why the output is produced by CALLING `buildStoredSamlConfig`
 *
 * The tempting shortcut is to hand-write `{issuer, entryPoint, cert,
 * callbackUrl: "", spMetadata: {}}` here. That is the same value today and it
 * will silently stop being the same value the first time someone edits the
 * canonical shape — and the failure is invisible, because a *different* stored
 * shape is exactly what this script exists to eliminate. So the only field
 * order that ever lands in the column is the one the application itself
 * writes, and `__tests__/sso/backfill-saml-shape.test.ts` pins that byte for
 * byte (`JSON.stringify(plan.canonical) === JSON.stringify(buildStoredSamlConfig(input))`
 * for the legacy shape). Key order is irrelevant to every reader — the column
 * is parsed JSON — but it is what makes the assertion above possible.
 *
 * ## Why this script needs its OWN, unextended Prisma client
 *
 * Same reason `scripts/encrypt-sso-secrets.ts` does, and the argument is
 * reproduced because it is not obvious: `lib/prisma.ts` exports a client
 * carrying `$extends({ result })` from `lib/prisma-sso-secret-extension.ts`,
 * which decrypts `samlConfig` and **normalises both storage formats to a
 * parsed object**. That is right for application code and wrong here, because
 * this script's first question about every row is "is this column plaintext
 * JSON or an `sso:v1:` envelope?" — a question that cannot be asked of a
 * value that has already been decrypted, because the answer was consumed by
 * the extension.
 *
 * Losing that answer is not a cosmetic loss, it changes what gets written:
 *
 *   - An envelope row must be re-written as an envelope. Writing plaintext
 *     back over it would silently *undo* `encrypt-sso-secrets.ts` for that
 *     row — a plaintext IdP client secret (and possibly a SAML `privateKey`)
 *     lands back in a `psql` dump, with no error anywhere. The read path
 *     keeps working, which is precisely why nobody would notice.
 *   - A plaintext row must stay plaintext. Promoting it here would make this
 *     script a second, ungated path into the encrypted format.
 *
 * `lib/prisma.ts` does not export an unextended client (`makeClient` is
 * private), so this constructs its own `PrismaClient`, and `assertRawColumns`
 * proves at runtime that the read really was raw — a client that decrypts on
 * read hands back objects, and without the check that mistake surfaces as a
 * table of `payload_not_json` rows that reads like key corruption and sends
 * someone hunting for a bad `AUTH_CONFIG_ENCRYPTION_KEY` that does not exist.
 *
 * ## Why the write is NOT gated on `SSO_CONFIG_ENCRYPTION_ENABLED`
 *
 * `encrypt-sso-secrets.ts` gates its write on that flag, and this one does
 * not — and the difference is the whole design. That flag exists for
 * **rollback safety**: a build from before the decrypt extension reads the
 * column with an unconditional `safeJsonParse`, so an envelope written by a
 * newer build is invisible to it and that provider cannot sign anyone in. The
 * flag's job is to keep that window closed.
 *
 * This script never changes the at-rest *format* of anything: a plaintext row
 * stays plaintext and an envelope row stays an envelope. It changes the
 * *contents* of an envelope, in the same format, under the same key. So the
 * rollback hazard this flag guards against cannot be created here, and
 * gating on it would mean the shape backfill is un-runnable on exactly the
 * deployments that have deliberately held the flag off — which is every
 * deployment today, since it defaults to off. A gate that blocks the repair
 * it is not protecting gets removed.
 *
 * What the flag *does* still govern is whether encryption is possible at all,
 * and that is checked the honest way: by attempting the decrypt. An envelope
 * row that cannot be decrypted (key missing, rotated, or simply not mounted
 * here) becomes `skipped-unreadable` and is **never overwritten**. Overwriting
 * a config this script cannot read would destroy a working provider in the
 * name of repairing it.
 *
 * ## Modes
 *
 *   (none) / `--dry-run` — the default. Report only. Nothing is written.
 *   `--apply`             — rewrite, in one transaction.
 *   `--verify`            — check every row against the invariants and report
 *                           drift. Writes nothing.
 *
 * `--dry-run` being the default is stated loudly rather than assumed, because
 * the failure this script guards against ("I ran the backfill and it wrote
 * straight to prod") is not recoverable by a rollback that also has to
 * restore every tenant's IdP secret.
 *
 * ## What "correct" means here — necessary, NOT sufficient
 *
 * A passing `--verify` proves four things about every row: `spMetadata` is
 * present and is a non-array object, `callbackUrl` is exactly `""`, `cert`
 * still parses as X.509, and `issuer` / `entryPoint` are byte-identical to
 * what was there before this script touched them.
 *
 * That is **necessary but not sufficient**. None of it exercises the plugin.
 * A config can satisfy all four invariants and still fail a real sign-in,
 * because sufficiency is a property of the AuthnRequest → assertion exchange
 * and nothing in this repo performs one. The SAML round-trip test (a local
 * IdP, a real login, an assertion posted to the ACS endpoint) is being
 * written separately and **does not exist here yet**. Do not read a green
 * `--verify` as "SAML works"; read it as "the shape can no longer be the
 * reason it does not".
 *
 * ## Transaction strategy
 *
 * **One transaction for the whole table**, and it holds only `UPDATE`s.
 *
 * The table is one row per enterprise tenant — small enough that a single
 * transaction has a cost bounded by a handful of index lookups, and small
 * enough that a chunked/resumable design would be more machinery than the
 * problem. The deeper reason is the failure mode: a mid-run crash that left
 * rows 1–3 converted and 4–7 not would leave the table in a state where some
 * providers work and some do not, with no record of the boundary, and the
 * operator's only way to find it is `--verify`. The single transaction makes
 * that outcome "nothing happened", which is a state that needs no
 * explanation.
 *
 * Idempotency is *not* the reason — the script is idempotent either way, so a
 * chunked design would be recoverable by re-running. It is chosen because
 * "recover by re-running" is a worse answer than "there is nothing to
 * recover" when the thing being repaired is a customer's ability to sign in.
 *
 * The read and the plan happen **outside** the transaction, so no decryption,
 * no X.509 parsing and no console output happens while it is open; it is a
 * sequence of updates and nothing else. Each update is a CAS-in-`WHERE`
 * (`updateMany` matching the exact raw string this run read), so a row edited
 * by an admin between the scan and the write aborts the whole transaction
 * rather than being clobbered by a config built from a value that no longer
 * exists.
 *
 * Usage:
 *   npx tsx scripts/backfill-sso-saml-shape.ts
 *   npx tsx scripts/backfill-sso-saml-shape.ts --verify
 *   npx tsx scripts/backfill-sso-saml-shape.ts --apply
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { validateSamlCert } from "@/lib/sso/provider-schemas";
import {
  buildStoredSamlConfig,
  readStoredSamlConfig,
  type SAMLConfig,
} from "@/lib/sso/stored-config";
import {
  decryptSecretPayload,
  encryptSecretPayload,
  isEncrypted,
  SecretPayloadError,
  type SecretPayloadFailure,
} from "@/lib/sso/secret-crypto";

/**
 * How the column is stored right now. Decided from the RAW column via
 * `isEncrypted`, never from a decrypted value — see the module header.
 */
export type SamlStorageFormat = "plaintext" | "envelope";

/**
 * One way a stored SAML config can fail to be usable by BetterAuth 1.6.5.
 *
 * A closed set, not free-form strings, so `--verify` output is greppable and
 * a new failure mode has to be named deliberately. Emitted in the fixed order
 * below so two runs of `--verify` produce byte-identical output.
 */
export type SamlInvariant =
  /** No `spMetadata` key. This is the defect — it is what 500s the sign-in. */
  | "sp-metadata-missing"
  /** `spMetadata` present but not a usable object (null, array, scalar). */
  | "sp-metadata-not-an-object"
  /** No `callbackUrl` key, or it is not a string. BetterAuth types it required. */
  | "callback-url-absent"
  /** `callbackUrl` is a string that is not `""` — i.e. someone can drift it. */
  | "callback-url-not-empty"
  /** `issuer` missing or not a string. */
  | "issuer-absent"
  /** `entryPoint` missing or not a string. */
  | "entry-point-absent"
  /** `cert` missing or not a string. */
  | "cert-absent"
  /** `cert` is a string that does not parse as X.509. */
  | "cert-not-x509";

/**
 * The two violations that describe *exactly* the shape the old create route
 * wrote — `{issuer, entryPoint, cert}`, with nothing else. Used to give the
 * operator the bug's own vocabulary ("legacy") instead of a key dump for the
 * case they are most likely to see.
 */
const LEGACY_ONLY_VIOLATIONS: readonly SamlInvariant[] = [
  "sp-metadata-missing",
  "callback-url-absent",
];

/**
 * Check a stored SAML config against everything this repo can check offline.
 *
 * Pure and total: it never throws and never coerces, because every field is
 * checked with `typeof` and a wrong-typed field is a *violation*, not
 * something to be papered over. That distinction is `lib/sso/stored-config.ts`'s
 * whole argument — a legacy `cert: 42` must fail the certificate check
 * loudly rather than reach `new X509Certificate(42)`.
 */
export function checkSamlInvariants(value: Record<string, unknown>): SamlInvariant[] {
  const violations: SamlInvariant[] = [];

  const spMetadata = value.spMetadata;
  if (spMetadata === undefined) {
    violations.push("sp-metadata-missing");
  } else if (
    typeof spMetadata !== "object" ||
    spMetadata === null ||
    Array.isArray(spMetadata)
  ) {
    // An array satisfies a bare `typeof === "object"` check while being
    // unusable by BetterAuth, so it is a violation, not a pass.
    violations.push("sp-metadata-not-an-object");
  }

  const callbackUrl = value.callbackUrl;
  if (typeof callbackUrl !== "string") {
    violations.push("callback-url-absent");
  } else if (callbackUrl !== "") {
    violations.push("callback-url-not-empty");
  }

  if (typeof value.issuer !== "string") violations.push("issuer-absent");
  if (typeof value.entryPoint !== "string") violations.push("entry-point-absent");

  const cert = value.cert;
  if (typeof cert !== "string") {
    violations.push("cert-absent");
  } else if (!validateSamlCert(cert)) {
    violations.push("cert-not-x509");
  }

  return violations;
}

/**
 * The invariants `buildStoredSamlConfig` is *responsible for* — i.e. the ones
 * that can only fail because the builder changed.
 *
 * `cert-not-x509` is deliberately NOT in this set. A certificate that does not
 * parse is a property of the customer's IdP, not of the object we build, and
 * it must not block the rewrite: the shape fix is independent of the
 * certificate, a row left un-rewritten stays broken in two ways instead of
 * one, and the run reports it as `rewritten-invalid-cert` with a non-zero exit
 * so it is still visible. Treating it as a blocker would mean a single bad PEM
 * anywhere in the table aborts the entire run before any write — turning a
 * repairable data problem into a deploy blocker.
 */
const BUILDER_OWNED_VIOLATIONS: readonly SamlInvariant[] = [
  "sp-metadata-missing",
  "sp-metadata-not-an-object",
  "callback-url-absent",
  "callback-url-not-empty",
  "issuer-absent",
  "entry-point-absent",
  "cert-absent",
];

/**
 * Refuse to proceed if the value this script is about to write is itself
 * malformed. Throws rather than returning a per-row skip, because a canonical
 * shape that fails its own invariants means `buildStoredSamlConfig` changed —
 * a code problem, and one that must abort the run *before* any write, not be
 * recorded per row as data.
 */
export function assertUsableSamlShape(value: Record<string, unknown>): void {
  const violations = checkSamlInvariants(value).filter((v) =>
    BUILDER_OWNED_VIOLATIONS.includes(v),
  );
  if (violations.length === 0) return;
  throw new Error(
    `Refusing to write a SAML config that is itself unusable (${violations.join(", ")}). ` +
      "buildStoredSamlConfig is supposed to emit spMetadata: {} and callbackUrl: \"\"; if " +
      "this fired, that function changed and this script has to be re-read before it runs " +
      "again. Nothing has been written.",
  );
}

/** What this script does with one row. */
export type BackfillAction =
  /** Stored shape was wrong and has been (or would be) rewritten. */
  | "rewritten"
  /**
   * Rewritten, but the row's `cert` does not parse as X.509 — so it is
   * **still** a broken provider after this run. Counted separately and never
   * as a successful rewrite, because a rewrite cannot fix a bad certificate
   * and reporting it as fixed is how it stays broken for another quarter.
   */
  | "rewritten-invalid-cert"
  /** Stored shape already satisfies every invariant. This is the no-op. */
  | "already-correct"
  /** `samlConfig` is null — an OIDC-only provider. Not a failure. */
  | "skipped-no-saml"
  /** The column could not be read. Never overwritten, never counted as done. */
  | "skipped-unreadable"
  /**
   * Readable, but not a SAML config this script can rebuild — the payload is
   * not an object, or `issuer` / `entryPoint` / `cert` are not strings. Left
   * untouched: writing a config with a field dropped would be inventing data.
   */
  | "skipped-not-a-saml-config";

/** Why a row was skipped, when it was. */
export type SkipReason =
  | SecretPayloadFailure
  | "payload-not-an-object"
  | "required-field-not-a-string";

/**
 * The decision for one row, with no IO in it.
 *
 * `canonical` is the object to serialise into the column, and is `null` unless
 * the row is actually being rewritten — so "we decided to leave it alone" and
 * "we decided what to write" cannot be confused by a caller that forgets to
 * check the action first.
 */
export interface SamlBackfillPlan {
  action: BackfillAction;
  /** How the column is stored now. `null` when there was nothing to read. */
  storage: SamlStorageFormat | null;
  /** Invariants the CURRENT stored value fails. Empty ⇒ already correct. */
  violations: SamlInvariant[];
  /** Set only for the two rewrite actions. */
  canonical: SAMLConfig | null;
  /** Set only for the skip actions. */
  reason: SkipReason | null;
  /** Operator-facing label for the shape as stored, e.g. `legacy{issuer,…}`. */
  beforeShape: string;
  /** Operator-facing label for the shape after this run. */
  afterShape: string;
}

/**
 * Short, stable label for a stored shape.
 *
 * `canonical` / `legacy{…}` / `noncanonical{…}` — the first because there is
 * nothing interesting to say, the second because it names the actual bug, the
 * third because anything else needs the key list to be diagnosable.
 */
function describeShape(
  value: Record<string, unknown>,
  violations: readonly SamlInvariant[],
): string {
  if (violations.length === 0) return "canonical";
  // Bare `.sort()`: this string is a diff key a human compares across runs and
  // across machines, so it has to be byte-identical everywhere. `localeCompare`
  // with no locale argument reads the host default and would make the same
  // shape render differently on two checkouts. See the note on the reserved-id
  // list in `lib/sso/provider-schemas.ts`.
  const keys = Object.keys(value).sort().join(",");
  const legacyOnly = violations.every((v) => LEGACY_ONLY_VIOLATIONS.includes(v));
  return legacyOnly ? `legacy{${keys}}` : `noncanonical{${keys}}`;
}

/**
 * Decrypts a raw column value into a parsed payload, or throws
 * `SecretPayloadError`. Injected so the planner below stays pure and so tests
 * can exercise the envelope path without a key.
 */
export type SamlDecrypt = (stored: string) => Record<string, unknown> | null;

/**
 * The production decrypt: `decryptSecretPayload` passes plaintext JSON through
 * unchanged and decrypts an `sso:v1:` envelope, which is exactly the
 * "both formats, one call" behaviour the planner needs. It is a *default
 * parameter* rather than an import inside the planner so that a test can pass
 * `JSON.parse` and exercise every branch without mounting a key.
 */
const defaultDecrypt: SamlDecrypt = (stored) =>
  decryptSecretPayload<Record<string, unknown>>(stored);

/**
 * Decide what should happen to one row. No IO, no environment, no throwing on
 * bad data — every branch returns a plan, and the only thing that throws is
 * `assertUsableSamlShape`, which fires on a *code* fault.
 *
 * The six branches, in the order they are detected:
 *
 *   1. `null` / empty column → `skipped-no-saml`. Detected before any decrypt,
 *      because a null column is an OIDC-only provider, not a failure.
 *   2. Undecryptable → `skipped-unreadable`, carrying the typed
 *      `SecretPayloadFailure` so the operator can tell a missing key from a
 *      rotated one from a genuinely corrupt row. Nothing is written.
 *   3. Payload is not a plain object → `skipped-not-a-saml-config`.
 *   4. `issuer` / `entryPoint` / `cert` not all strings →
 *      `skipped-not-a-saml-config`. This is the branch where a legacy
 *      `cert: 42` lands, and the reason it must not be rewritten: there is no
 *      certificate to rebuild from.
 *   5. Zero violations → `already-correct`. The idempotency branch — a second
 *      run of `--apply` lands here for every row.
 *   6. Anything else → `rewritten`, or `rewritten-invalid-cert` when
 *      `cert-not-x509` is among the violations.
 */
export function planSamlBackfill(
  rawColumn: string | null,
  decrypt: SamlDecrypt = defaultDecrypt,
): SamlBackfillPlan {
  if (rawColumn === null || rawColumn === "") {
    return {
      action: "skipped-no-saml",
      storage: null,
      violations: [],
      canonical: null,
      reason: null,
      beforeShape: "none",
      afterShape: "none",
    };
  }

  // Read from the RAW column, so this is meaningful. Against the extended
  // client the value is already an object and `isEncrypted` is false for every
  // row — which is why `assertRawColumns` guards the whole run.
  const storage: SamlStorageFormat = isEncrypted(rawColumn)
    ? "envelope"
    : "plaintext";

  let payload: Record<string, unknown> | null;
  try {
    payload = decrypt(rawColumn);
  } catch (err) {
    // Only `SecretPayloadError` is a row-level outcome. Anything else is a bug
    // in this script or in the decrypt implementation, and swallowing it would
    // report a whole table as unreadable when the truth is that the reader is
    // broken.
    if (!(err instanceof SecretPayloadError)) throw err;
    return {
      action: "skipped-unreadable",
      storage,
      violations: [],
      canonical: null,
      reason: err.failure,
      beforeShape: "unreadable",
      afterShape: "unchanged",
    };
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      action: "skipped-not-a-saml-config",
      storage,
      violations: [],
      canonical: null,
      reason: "payload-not-an-object",
      beforeShape: "non-object",
      afterShape: "unchanged",
    };
  }

  const narrowed = readStoredSamlConfig(payload);
  const { issuer, entryPoint, cert } = narrowed ?? {};
  if (
    typeof issuer !== "string" ||
    typeof entryPoint !== "string" ||
    typeof cert !== "string"
  ) {
    const missing = [
      ...(typeof issuer !== "string" ? ["issuer"] : []),
      ...(typeof entryPoint !== "string" ? ["entryPoint"] : []),
      ...(typeof cert !== "string" ? ["cert"] : []),
    ];
    return {
      action: "skipped-not-a-saml-config",
      storage,
      violations: checkSamlInvariants(payload),
      canonical: null,
      reason: "required-field-not-a-string",
      beforeShape: `unbuildable{${missing.join(",")}}`,
      afterShape: "unchanged",
    };
  }

  // The canonical value, produced by the same function the create route calls —
  // see "Why the output is produced by CALLING buildStoredSamlConfig".
  //
  // The existing payload is spread *underneath* it, which is what makes this
  // safe for rows this script was not written for. A config that carries
  // BetterAuth fields this repo does not model (`privateKey`, `idpCert`)
  // keeps them: dropping a signing key turns a provider that works after this
  // run into one that cannot sign its own AuthnRequest. The canonical fields
  // spread last, so they always win — which is how a hand-set `callbackUrl`
  // gets reset to `""` rather than preserved.
  const canonical = {
    ...payload,
    ...buildStoredSamlConfig({ issuer, entryPoint, cert }),
  } as SAMLConfig & Record<string, unknown>;

  assertUsableSamlShape(canonical);

  const violations = checkSamlInvariants(payload);
  if (violations.length === 0) {
    return {
      action: "already-correct",
      storage,
      violations,
      canonical: null,
      reason: null,
      beforeShape: "canonical",
      afterShape: "canonical",
    };
  }

  return {
    // A bad cert does not stop the rewrite — the shape fix is independent of
    // the certificate, and leaving the row un-rewritten means it stays broken
    // in two ways instead of one. But it is reported as its own action and is
    // not counted as a successful rewrite: this provider is still down after
    // the run, and only cert rotation (delete-then-recreate) fixes it.
    action: violations.includes("cert-not-x509")
      ? "rewritten-invalid-cert"
      : "rewritten",
    storage,
    violations,
    canonical,
    reason: null,
    beforeShape: describeShape(payload, violations),
    afterShape: "canonical",
  };
}

// ---------------------------------------------------------------------------
// IO layer. Everything below this line touches the database or the console.
// ---------------------------------------------------------------------------

/** One provider row plus the plan made for it. */
interface RowPlan extends SamlBackfillPlan {
  id: string;
  providerId: string;
  domain: string;
  organizationId: string | null;
  /** The raw column as read. Re-used as the CAS guard in the UPDATE. */
  rawColumn: string | null;
  /** Exactly the bytes that will be stored. `null` unless this is a rewrite. */
  nextColumnValue: string | null;
}

/**
 * Fail before writing anything if the read is not actually raw.
 *
 * Copied in spirit from `scripts/encrypt-sso-secrets.ts` — same mistake, same
 * protection, and the comment there explains why a runtime proof beats a
 * comment: a client that decrypts on read hands back objects, so every row
 * would look "plaintext" and every rewrite would write plaintext over a
 * customer's encrypted IdP secret.
 */
function assertRawColumns(
  providers: { providerId: string; samlConfig: unknown }[],
): void {
  const decrypted = providers.find(
    ({ samlConfig }) => samlConfig !== null && typeof samlConfig !== "string",
  );
  if (!decrypted) return;
  throw new Error(
    `Refusing to run: ${decrypted.providerId}.samlConfig came back as ` +
      `${typeof decrypted.samlConfig}, not a string. This means the read went through a ` +
      "Prisma client carrying the ssoProvider result extension, which decrypts the column " +
      "before returning it. This job must see the raw stored bytes so it can tell an sso:v1: " +
      "envelope from legacy plaintext JSON and re-write each row in the SAME format. " +
      "Construct the client with `new PrismaClient({ adapter })` and do NOT import it from " +
      "lib/prisma.",
  );
}

/**
 * A deliberately unextended client.
 *
 * Constructed inside `main()` rather than at module scope so that importing
 * this file — which `__tests__/sso/backfill-saml-shape.test.ts` does, for the
 * pure planner — never builds a client at all. The `PrismaPg` config is
 * intentionally not copied from `lib/prisma.ts`: that file's ~3s connect
 * budget exists to stop a saturated pooler eating a Netlify function's
 * ceiling, and this is a batch job with no function ceiling.
 */
function makeRawPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 60_000,
    }),
  });
}

const USAGE = `
  Backfill SsoProvider.samlConfig to the shape buildStoredSamlConfig produces.

  Usage: npx tsx -r dotenv/config scripts/backfill-sso-saml-shape.ts [mode]

  Modes (dry run is the default; nothing is written without --apply):
    (none)      report what would change, write nothing
    --dry-run   identical to the default, stated explicitly
    --verify    check every row against the invariants and report drift
    --apply     rewrite the rows that need it, in one transaction
    --help      this text

  Notes:
    - Reads the RAW column via its own unextended PrismaClient, so it can see
      whether a row is an 'sso:v1:' envelope and re-write it in the same
      format. Do not "simplify" it to import lib/prisma.
    - Needs DATABASE_URL. Rows stored as envelopes additionally need
      AUTH_CONFIG_ENCRYPTION_KEY; a row that cannot be decrypted is reported
      and left untouched, never overwritten.
    - A passing --verify is necessary but NOT sufficient. Sufficiency comes
      from a SAML round-trip against a real IdP, which does not exist in this
      repo yet.
`.trimStart();

interface Mode {
  apply: boolean;
  verify: boolean;
  help: boolean;
}

function parseMode(argv: readonly string[]): Mode {
  return {
    apply: argv.includes("--apply"),
    verify: argv.includes("--verify"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

/** One console line per provider. */
function reportRow(plan: RowPlan, mode: "dry-run" | "apply" | "verify"): void {
  const scope = `org=${plan.organizationId ?? "(none)"}`;
  const where = `${plan.providerId}  ${plan.domain}  ${scope}`;
  const storage = plan.storage ? `  [${plan.storage}]` : "";

  if (mode === "verify") {
    if (plan.action === "skipped-no-saml") {
      console.log(`   ·  ${where}  no samlConfig — not a SAML provider`);
      return;
    }
    if (plan.action === "skipped-unreadable") {
      console.error(
        `   ❌ ${where}  UNREADABLE (${plan.reason}) — left untouched${storage}`,
      );
      return;
    }
    if (plan.action === "skipped-not-a-saml-config") {
      console.error(
        `   ❌ ${where}  NOT A SAML CONFIG (${plan.reason}) — ${plan.beforeShape}, left untouched${storage}`,
      );
      return;
    }
    if (plan.violations.length === 0) {
      console.log(`   ✅ ${where}  all invariants hold${storage}`);
      return;
    }
    console.error(
      `   ❌ ${where}  DRIFT: ${plan.violations.join(", ")}${storage}`,
    );
    return;
  }

  switch (plan.action) {
    case "skipped-no-saml":
      console.log(`   ·  ${where}  no samlConfig — skipped (OIDC-only provider)`);
      return;
    case "skipped-unreadable":
      console.error(
        `   ❌ ${where}  ${plan.beforeShape} (${plan.reason}) → unchanged  NOT OVERWRITTEN${storage}`,
      );
      return;
    case "skipped-not-a-saml-config":
      console.error(
        `   ❌ ${where}  ${plan.beforeShape} (${plan.reason}) → unchanged${storage}`,
      );
      return;
    case "already-correct":
      console.log(
        `   ✅ ${where}  ${plan.beforeShape} → ${plan.afterShape}  already-correct${storage}`,
      );
      return;
    case "rewritten":
      console.log(
        `   ↻  ${where}  ${plan.beforeShape} → ${plan.afterShape}${
          mode === "apply" ? "  rewritten" : "  would rewrite"
        }${storage}`,
      );
      return;
    case "rewritten-invalid-cert":
      console.error(
        `   ⚠️  ${where}  ${plan.beforeShape} → ${plan.afterShape}  ${
          mode === "apply" ? "rewritten" : "would rewrite"
        } — BUT cert-not-x509: this provider is STILL BROKEN afterwards${storage}`,
      );
      return;
  }
}

function summarise(
  plans: RowPlan[],
  mode: "dry-run" | "apply" | "verify",
): Record<string, number | string> {
  const count = (action: BackfillAction) =>
    plans.filter((p) => p.action === action).length;
  return {
    event: `sso_saml_shape_backfill_${mode.replace("-", "_")}`,
    mode,
    providers: plans.length,
    rewritten: count("rewritten"),
    rewrittenInvalidCert: count("rewritten-invalid-cert"),
    alreadyCorrect: count("already-correct"),
    skippedNoSaml: count("skipped-no-saml"),
    skippedUnreadable: count("skipped-unreadable"),
    skippedNotSamlConfig: count("skipped-not-a-saml-config"),
    // Rows whose stored value violates at least one invariant. Equivalent to
    // `rewritten + rewrittenInvalidCert`, except that a row skipped as
    // unreadable contributes no violations (nothing could be read to check).
    drifted: plans.filter((p) => p.violations.length > 0).length,
  };
}

/**
 * Group the rows that need a human by *reason*, so an operator can tell "one
 * key mismatch" from "one genuinely corrupt row" without reading every line.
 * Same shape as the failure block in `scripts/encrypt-sso-secrets.ts`.
 */
function reportProblems(plans: RowPlan[]): void {
  const problems = plans.filter(
    (p) =>
      p.action === "skipped-unreadable" ||
      p.action === "skipped-not-a-saml-config" ||
      p.action === "rewritten-invalid-cert",
  );
  if (problems.length === 0) return;

  const byReason = new Map<string, RowPlan[]>();
  for (const plan of problems) {
    const bucket = byReason.get(plan.reason ?? plan.action) ?? [];
    bucket.push(plan);
    byReason.set(plan.reason ?? plan.action, bucket);
  }

  for (const [reason, rows] of byReason) {
    console.error(`\n❌ ${reason} — ${rows.length} row(s) need a human:`);
    for (const row of rows) {
      console.error(
        `   ${row.providerId}  ${row.domain}  org=${row.organizationId ?? "(none)"}`,
      );
    }
  }

  const unreadable = plans.filter((p) => p.action === "skipped-unreadable");
  if (unreadable.length > 0) {
    console.error(
      "\n   An unreadable row was NOT modified. `key_unavailable` means " +
        "AUTH_CONFIG_ENCRYPTION_KEY is not mounted or is not 64 hex characters; " +
        "`auth_failed` means the key is wrong for this row (rotated without re-running " +
        "the encryption job). Fix the key and re-run — never delete the row.",
    );
  }
  const badCert = plans.filter((p) => p.action === "rewritten-invalid-cert");
  if (badCert.length > 0) {
    console.error(
      "\n   A rewritten row whose cert does not parse is STILL a broken provider. " +
        "The shape fix cannot help it; recovery is cert rotation (DELETE then re-POST — " +
        "see the cert-rotation runbook in the SSO doc).",
    );
  }
}

async function main(): Promise<void> {
  const { apply, verify, help } = parseMode(process.argv.slice(2));

  if (help) {
    console.log(USAGE);
    return;
  }

  if (apply && verify) {
    console.error(
      "❌ --apply and --verify are contradictory. --verify writes nothing by " +
        "definition; run it on its own, then run --apply.\n",
    );
    process.exit(1);
  }

  const mode: "dry-run" | "apply" | "verify" = apply
    ? "apply"
    : verify
      ? "verify"
      : "dry-run";

  if (mode === "dry-run") {
    // Loud on purpose — see the module header on why the default must not be
    // mistaken for a decision to write.
    console.log(
      "⚠️  No mode flag given (or --dry-run): running in DRY RUN. Nothing will be written.\n" +
        "   Pass --apply to rewrite, or --verify to check invariants only.\n",
    );
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "❌ Refusing to run: DATABASE_URL is not set. Run with\n" +
        "   `npx tsx -r dotenv/config scripts/backfill-sso-saml-shape.ts`\n" +
        "   or export the variable explicitly.",
    );
    process.exit(1);
  }

  const prisma = makeRawPrisma();

  try {
    const providers = await prisma.ssoProvider.findMany({
      select: {
        id: true,
        providerId: true,
        domain: true,
        organizationId: true,
        samlConfig: true,
      },
    });

    assertRawColumns(providers);

    console.log(
      mode === "verify"
        ? `🔍 SSO SAML shape verify — READ ONLY (no writes)\n   Providers: ${providers.length}`
        : `🔧 SSO SAML shape backfill — ${mode === "apply" ? "APPLY" : "DRY RUN"}\n` +
          `   Providers: ${providers.length}\n` +
          `   Mode: ${mode === "apply" ? "will write to SsoProvider.samlConfig" : "report only"}`,
    );

    const plans: RowPlan[] = providers.map((provider) => {
      const plan = planSamlBackfill(provider.samlConfig);
      const rewrites =
        plan.action === "rewritten" || plan.action === "rewritten-invalid-cert";
      return {
        ...plan,
        id: provider.id,
        providerId: provider.providerId,
        domain: provider.domain,
        organizationId: provider.organizationId,
        rawColumn: provider.samlConfig,
        // Computed HERE, outside the transaction, so the transaction holds
        // UPDATEs and nothing else. An envelope row re-encrypts to different
        // bytes on every run — the format is preserved, the ciphertext is not
        // reproducible — which is exactly why "already-correct" has to be
        // decided on the *decrypted* payload rather than on the column bytes.
        nextColumnValue: rewrites && plan.canonical
          ? plan.storage === "envelope"
            ? encryptSecretPayload(plan.canonical)
            : JSON.stringify(plan.canonical)
          : null,
      };
    });

    for (const plan of plans) reportRow(plan, mode);

    if (mode === "apply") {
      const rewrites = plans.filter((p) => p.nextColumnValue !== null);
      if (rewrites.length > 0) {
        await prisma.$transaction(
          async (tx) => {
            for (const plan of rewrites) {
              const { count } = await tx.ssoProvider.updateMany({
                // CAS-in-WHERE on the exact bytes this run read. A row edited
                // by an admin between the scan and this write aborts the
                // whole transaction rather than being overwritten with a
                // config derived from a value that no longer exists.
                where: { id: plan.id, samlConfig: plan.rawColumn },
                data: { samlConfig: plan.nextColumnValue },
              });
              if (count !== 1) {
                throw new Error(
                  `Row ${plan.providerId} changed since it was read (expected 1 update, ` +
                    `matched ${count}). Aborting so nothing is left half-migrated — ` +
                    "re-run to pick up the current values.",
                );
              }
            }
          },
          // Batch job, no function ceiling. The default 5s timeout is a
          // request-path number; a saturated pooler (see lib/prisma.ts on
          // Supavisor) has been measured hanging 5-9.6s on connect, and
          // aborting this transaction because of that would waste the run.
          { maxWait: 10_000, timeout: 60_000 },
        );
        console.log(
          `\n✅ Applied ${rewrites.length} rewrite(s) in one transaction. Re-running now reports zero changes.`,
        );
      } else {
        console.log("\n✅ Nothing to write — every row is already correct.");
      }
    }

    console.log(`\n📊 ${JSON.stringify(summarise(plans, mode))}`);

    if (mode === "verify") {
      const bad = plans.filter(
        (p) =>
          p.action === "skipped-unreadable" ||
          p.action === "skipped-not-a-saml-config" ||
          p.action === "rewritten-invalid-cert" ||
          p.action === "rewritten",
      );
      if (bad.length > 0) {
        console.error(
          `\n   ${bad.length} row(s) do not satisfy the invariants. Run without ` +
            "--verify to see the rewrite plan, then --apply.",
        );
        process.exitCode = 1;
      } else {
        console.log(
          "\n   ✅ Every SAML row satisfies the invariants.\n" +
            "   ⚠️  NECESSARY BUT NOT SUFFICIENT. This proves the stored shape, not that a\n" +
            "   sign-in works. Sufficiency comes from a SAML round-trip against a real\n" +
            "   IdP — an AuthnRequest built from this config and an assertion posted back\n" +
            "   to the ACS endpoint — and that test does not exist in this repo yet.\n" +
            "   Do not read a green --verify as \"SAML works\".",
        );
      }
    } else if (mode === "dry-run") {
      const pending = plans.filter((p) => p.nextColumnValue !== null);
      if (pending.length > 0) {
        console.log(
          `\n   ${pending.length} row(s) would be rewritten. Re-run with --apply to do it.`,
        );
      }
    }

    reportProblems(plans);

    const unreadable = plans.filter((p) => p.action === "skipped-unreadable");
    const unbuildable = plans.filter(
      (p) => p.action === "skipped-not-a-saml-config",
    );
    const badCert = plans.filter((p) => p.action === "rewritten-invalid-cert");
    if (unreadable.length + unbuildable.length + badCert.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Run only when this file is the process entrypoint. `npx tsx scripts/…`
 * puts this path in `process.argv[1]`; under Jest it is the Jest CLI, which is
 * what lets `__tests__/sso/backfill-saml-shape.test.ts` import the pure
 * planner above without a database or a side effect.
 */
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /backfill-sso-saml-shape\.[cm]?tsx?$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
