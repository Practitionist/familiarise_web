/**
 * #1093 §3 / #1169 PR 9 — a nullable unique deduplicates nothing, so the
 * writers must never send null. The NOT NULL flips are staged for the reset;
 * until then these contracts are the guarantee.
 */

import fs from "fs";
import path from "path";

import { parseMigrationsDirectory } from "../../scripts/db/sidecar-objects";

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
      src.match(
        /idempotencyKey:\s*opts\.idempotencyKey \?\? globalThis\.crypto\.randomUUID\(\)/g,
      ),
    ).toHaveLength(1);
    expect(src).toContain("idempotencyKey: created.idempotencyKey");
  });

  it("the drift guard sees every live object, including the once-staged ones", () => {
    // Runs the PRODUCTION parser over the real sidecar file, so this guards the
    // script rather than a copy of its regexes. The guard used to split on the
    // staged-for-reset banner, which also discarded the ACTIVE SQL below it —
    // `appointment_doc_thread_version_unique` and `onboarding_draft_payload_size`
    // were silently never asserted.
    const names = parseMigrationsDirectory().map((o) => o.name);

    // Applied at the reset (#1554) — demanded of the database from now on.
    expect(names).toContain("program_assignment_no_active_overlap");
    expect(names).toContain("subscription_plan_total_sessions_min");
    expect(names).toContain("cancellation_policy_one_active_per_scope");
    // Live, and below the old banner — these are the ones the old split lost.
    expect(names).toContain("appointment_doc_thread_version_unique");
    expect(names).toContain("onboarding_draft_payload_size");
    // `consultant_review_legacy_pair_key` used to live here. Reviews are now one
    // per (consultant, consultee), which Prisma expresses as a real @@unique, so
    // the sidecar's partial index was retired rather than left shadowing it.
    // `IF NOT EXISTS` must not be captured as an index name.
    expect(names).not.toContain("IF");
  });
});
