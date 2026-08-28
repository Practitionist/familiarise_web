/**
 * #1093 §3 / #1169 PR 9 — a nullable unique deduplicates nothing, so the
 * writers must never send null. The NOT NULL flips are staged for the reset;
 * until then these contracts are the guarantee.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("idempotency keys are always minted (#1093 §3)", () => {
  it("checkout mints clientIdempotencyKey when the client omits it", () => {
    const src = read("app/api/checkout/route.ts");
    expect(src).toContain(
      "validatedData.clientIdempotencyKey ??= globalThis.crypto.randomUUID()",
    );
  });

  it("org payouts mint the key once, at the writer, and echo it into the audit row", () => {
    const src = read("lib/payments/payouts/org-payout-service.ts");
    expect(src).not.toMatch(/idempotencyKey:\s*[^,\n]*\?\?\s*null/);
    // Exactly one mint, on the payout row. A second mint had landed in the
    // audit payload, stamping details with a UUID matching no payout row.
    expect(
      src.split("idempotencyKey: opts.idempotencyKey ?? globalThis.crypto.randomUUID()")
        .length,
    ).toBe(2);
    expect(src).toContain("idempotencyKey: created.idempotencyKey");
  });

  it("the sidecar stages the NOT NULL flips for the reset", () => {
    const sql = read("prisma/sql/check-constraints.sql");
    const staged = sql.slice(sql.indexOf("STAGED FOR THE PRE-MVP RESET"));
    expect(staged).toContain('"clientIdempotencyKey" SET NOT NULL');
    expect(staged).toContain('"OrganizationPayout" ALTER COLUMN "idempotencyKey" SET NOT NULL');
  });

  it("the drift guard ignores the staged block but sees every live object", () => {
    // Asserted behaviourally rather than by pinning the implementation string.
    // The guard used to split on the banner, which also discarded the ACTIVE
    // SQL that sits below it — `appointment_doc_thread_version_unique` and
    // `onboarding_draft_payload_size` were silently never asserted. What
    // actually excludes a staged object is that it is COMMENTED OUT, so that
    // is what this pins.
    const script = read("scripts/db/assert-sidecar-applied.ts");
    expect(script).toContain('.startsWith("--")');

    const active = read("prisma/sql/check-constraints.sql")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const names = [
      ...active.matchAll(/ADD CONSTRAINT "?([A-Za-z0-9_]+)"?/g),
      ...active.matchAll(
        /CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?/g,
      ),
    ].map((m) => m[1]);

    // Staged for the reset — must NOT be demanded of a live database.
    expect(names).not.toContain("program_assignment_no_active_overlap");
    expect(names).not.toContain("subscription_plan_total_sessions_min");
    // Live, and below the banner — these are the ones the old split lost.
    expect(names).toContain("appointment_doc_thread_version_unique");
    expect(names).toContain("onboarding_draft_payload_size");
    expect(names).toContain("consultant_review_legacy_pair_key");
    // `IF NOT EXISTS` must not be captured as an index name.
    expect(names).not.toContain("IF");
  });
});
