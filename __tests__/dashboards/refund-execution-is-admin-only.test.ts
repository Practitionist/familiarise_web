/**
 * @jest-environment node
 */

/**
 * `POST /api/admin/refunds` executes a refund — it moves real money.
 *
 * The mutation resolves `refunds.manage` through BACKOFFICE_PERMISSIONS,
 * which is ADMIN-only, while GET asks `refunds.read`, which staff hold for
 * ticket context.
 */

// Only the pure matrix module is imported. `lib/auth-helpers` drags the
// BetterAuth ESM chain through jest; the guard it exports is asserted at the
// source level below instead.
import { readFileSync } from "fs";
import { join } from "path";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

describe("refund execution is admin-only", () => {
  it("route source guards POST through the refunds.manage ops door, with step-up", () => {
    // Source-level assertion: the alternative is standing up the whole
    // refundPayment path, and what matters here is which guard the mutation uses.
    const src = readFileSync(
      join(process.cwd(), "app/api/admin/refunds/route.ts"),
      "utf8",
    );

    const doorBody = src.slice(src.indexOf("const refundDoor"));
    expect(doorBody).toMatch(/withOpsAction\(\s*"refunds\.manage"/);
    expect(doorBody).toContain("stepUp: true");
    expect(doorBody).not.toMatch(/require\w*Auth\(\)/);

    // GET keeps the wider grant — staff read every money surface.
    const getBody = src.slice(
      src.indexOf("export async function GET"),
      src.indexOf("const refundDoor"),
    );
    expect(getBody).toContain('requireBackofficeSurface("refunds.read")');
    expect(hasBackofficePermission("STAFF", "refunds.read")).toBe(true);
  });

  it("refunds.manage excludes STAFF and admits ADMIN", () => {
    expect(hasBackofficePermission("STAFF", "refunds.manage")).toBe(false);
    expect(hasBackofficePermission("ADMIN", "refunds.manage")).toBe(true);
  });

  it("every money mutation surface is admin-only", () => {
    // The whole point of the split: staff read money, admin moves it.
    const mutations: BackofficeSurface[] = [
      "payments.manage",
      "refunds.manage",
      "disputes.manage",
      "invoices.manage",
      "subscriptions.manage",
      "payouts.manage",
      "approvalPayments.manage",
    ];
    for (const surface of mutations) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });

  it("auth-helpers exports the surface-scoped guard the route imports", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/auth-helpers.ts"),
      "utf8",
    );
    expect(src).toContain("export async function requireBackofficeSurface");
  });
});
