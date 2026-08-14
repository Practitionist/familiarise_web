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

  it("org payouts never write a null idempotencyKey", () => {
    const src = read("lib/payments/payouts/org-payout-service.ts");
    expect(src).not.toContain("idempotencyKey: opts.idempotencyKey ?? null");
    expect(
      src.split("idempotencyKey: opts.idempotencyKey ?? globalThis.crypto.randomUUID()")
        .length,
    ).toBe(3);
  });

  it("the sidecar stages the NOT NULL flips for the reset", () => {
    const sql = read("prisma/sql/check-constraints.sql");
    const staged = sql.slice(sql.indexOf("STAGED FOR THE PRE-MVP RESET"));
    expect(staged).toContain('"clientIdempotencyKey" SET NOT NULL');
    expect(staged).toContain('"OrganizationPayout" ALTER COLUMN "idempotencyKey" SET NOT NULL');
  });

  it("the drift guard ignores the staged block", () => {
    const script = read("scripts/db/assert-sidecar-applied.ts");
    expect(script).toContain('split("STAGED FOR THE PRE-MVP RESET")[0]');
  });
});
