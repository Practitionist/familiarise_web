/**
 * The staff/admin split lives in exactly one place — BACKOFFICE_PERMISSIONS —
 * and three consumers read it: the sidebar (visibility), the page guards, and
 * the API routes. These tests pin the policy so a surface can't quietly widen,
 * and pin the invariant that made the two dashboards drift in the first place:
 * a nav item must never appear for a role whose guard would then reject it.
 */

import {
  BACKOFFICE_PERMISSIONS,
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";
import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";
import {
  resolveBackofficeCapability,
  type BackofficeTree,
} from "@/lib/backoffice/capability";

// The tree's own role: an admin in the admin tree, staff in the staff tree.
const nav = (tree: BackofficeTree, options = {}) =>
  buildBackofficeNav(
    resolveBackofficeCapability(tree === "admin" ? "ADMIN" : "STAFF", tree)!,
    options,
  );

const flatten = (groups: ReturnType<typeof buildBackofficeNav>) =>
  groups.flatMap((g) => g.items.map((i) => i.path));

describe("BACKOFFICE_PERMISSIONS", () => {
  it("grants STAFF read on the money surfaces they need for ticket context", () => {
    for (const surface of [
      "payments.read",
      "refunds.read",
      "disputes.read",
      "invoices.read",
      "subscriptions.read",
      "payouts.read",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(true);
    }
  });

  it("never grants STAFF a money mutation", () => {
    for (const surface of [
      "payments.manage",
      "refunds.manage",
      "disputes.manage",
      "invoices.manage",
      "subscriptions.manage",
      "payouts.manage",
      "approvalPayments.manage",
      "tds.read",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
    }
  });

  it("keeps destructive user actions and platform control admin-only", () => {
    for (const surface of [
      "users.moderate",
      "organizations.manage",
      "announcements.manage",
      "systemJobs.manage",
      "maintenance.manage",
      // #1527 — Leads (§17b), compliance (Q5) and the newsletter send.
      "leads.manage",
      "compliance.manage",
      "newsletter.send",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(false);
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });

  it("gives STAFF the whole support remit", () => {
    for (const surface of [
      "tickets.manage",
      "feedback.manage",
      "moderation.manage",
      "appointments.manage",
      "waitlist.manage",
      "users.read",
      "users.verify",
    ] as BackofficeSurface[]) {
      expect(hasBackofficePermission("STAFF", surface)).toBe(true);
    }
  });

  it("grants ADMIN every surface", () => {
    for (const surface of Object.keys(
      BACKOFFICE_PERMISSIONS,
    ) as BackofficeSurface[]) {
      expect(hasBackofficePermission("ADMIN", surface)).toBe(true);
    }
  });
});

describe("buildBackofficeNav", () => {
  it("never shows a staff-tree item the STAFF role cannot reach", () => {
    // The exact class of bug the matrix exists to prevent: a visible tab whose
    // page guard 403s. Every rendered path must resolve to a granted surface.
    const forbidden = [
      "money/earnings",
      "money/reconcile",
      "tds",
      "organizations",
      "compliance",
      "announcements",
      "system-jobs",
      "maintenance",
      "analytics",
      "leads",
      "home",
    ];
    const staffPaths = flatten(nav("staff", { showTds: true }));
    for (const path of forbidden) {
      expect(staffPaths).not.toContain(path);
    }
  });

  it("gives the admin tree the full surface list", () => {
    const adminPaths = flatten(nav("admin", { showTds: true }));
    for (const path of [
      "home",
      "tickets",
      "feedback",
      "moderation",
      "appointments",
      "waitlist",
      "leads",
      "users",
      // Each money section is its own item at its /money/<key> URL.
      "money/payments",
      "money/refunds",
      "money/disputes",
      "money/payouts",
      "money/earnings",
      "money/reconcile",
      "invoices",
      "subscriptions",
      "tds",
      "verification",
      "compliance",
      "analytics",
      "organizations",
      "announcements",
      "system-jobs",
      "maintenance",
    ]) {
      expect(adminPaths).toContain(path);
    }
  });

  it("closes both sidebars with the audit log, outside the Money group", () => {
    for (const tree of ["admin", "staff"] as const) {
      const groups = nav(tree);
      const last = groups[groups.length - 1];
      expect(last.label).toBeUndefined();
      expect(last.items.map((i) => i.path)).toEqual(["money/audit"]);
    }
  });

  it("keeps Metrics staff-only and Analytics admin-only", () => {
    // Not a rename of one another: different endpoints, different questions
    // (support-queue health vs platform revenue).
    expect(flatten(nav("staff"))).toContain("metrics");
    expect(flatten(nav("staff"))).not.toContain("analytics");
    expect(flatten(nav("admin"))).toContain("analytics");
    expect(flatten(nav("admin"))).not.toContain("metrics");
  });

  it("honours the TDS feature flag on the admin tree", () => {
    expect(flatten(nav("admin", { showTds: false }))).not.toContain("tds");
    expect(flatten(nav("admin", { showTds: true }))).toContain("tds");
  });

  it("emits no empty groups", () => {
    for (const tree of ["admin", "staff"] as const) {
      for (const group of nav(tree)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("shows an admin in the staff tree exactly the staff console", () => {
    const adminAsStaff = buildBackofficeNav(
      resolveBackofficeCapability("ADMIN", "staff")!,
      { showTds: true },
    );
    expect(flatten(adminAsStaff)).toEqual(
      flatten(nav("staff", { showTds: true })),
    );
  });

  it("gives the staff tree strictly fewer items than the admin tree", () => {
    const staff = flatten(nav("staff", { showTds: true }));
    const admin = flatten(nav("admin", { showTds: true }));
    expect(staff.length).toBeLessThan(admin.length);
  });
});
