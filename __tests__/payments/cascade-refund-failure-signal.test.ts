/**
 * @jest-environment node
 */

/**
 * PM-34 (#677) — a failed refund-earning cascade must surface as failure.
 *
 * The cron used to exit green (exit 0 / HTTP 200) even when
 * result.success === false, so the monitor never paged while SUCCEEDED
 * refunds sat un-cascaded. Pins the shared decision helper and the wiring
 * at both consumers (GH Actions entry + HTTP shim).
 *
 * The wiring asserts are source-level (same pattern as
 * __tests__/security/audit-1132-security.test.ts) because the consumers'
 * import chains drag prisma + the Redis-backed cron lock into any direct
 * require — the leaf helper module exists precisely so the decision itself
 * stays unit-testable without them.
 */

import fs from "node:fs";
import path from "node:path";

import { cascadeRunFailed } from "@/scripts/refunds/cascade-run-outcome";

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("PM-34 — cascade failure decision helper", () => {
  it("success=false → failed (page)", () => {
    expect(cascadeRunFailed({ success: false })).toBe(true);
  });

  it("success=true → not failed", () => {
    expect(cascadeRunFailed({ success: true })).toBe(false);
  });
});

describe("PM-34 — inlined refund cascade surfaces failure via reconcilePendingRefunds", () => {
  it("reconcile-pending-refunds invokes applyRefundCascade inline and reports success: errors.length === 0", () => {
    const src = read("scripts/refunds/reconcile-pending-refunds.ts");

    expect(src).toMatch(/applyRefundCascade\(/);
    expect(src).toMatch(/success:\s*errors\.length === 0/);
  });
});
