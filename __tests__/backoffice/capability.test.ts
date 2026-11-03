/**
 * One back-office route tree. Pins the capability matrix (tree = audience,
 * role caps it) and the staff twin of an admin URL.
 */

import {
  backofficeLandingHref,
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
  staffTwinHref,
} from "@/lib/backoffice/capability";

describe("resolveBackofficeCapability / can", () => {
  it("admits only operators, and never STAFF into the admin tree", () => {
    expect(resolveBackofficeCapability("CONSULTANT", "staff")).toBeNull();
    expect(resolveBackofficeCapability(null, "admin")).toBeNull();
    expect(resolveBackofficeCapability("STAFF", "admin")).toBeNull();
    expect(resolveBackofficeCapability("STAFF", "staff")).toEqual({
      tree: "staff",
      basePath: "/dashboard/staff",
      role: "STAFF",
      audience: "STAFF",
    });
    expect(isBackofficeTree("consultant")).toBe(false);
  });

  it.each([
    // [role, tree, surface, expected]
    ["ADMIN", "admin", "refunds.manage", true],
    ["ADMIN", "staff", "refunds.manage", false], // the staff console, even for admin
    ["STAFF", "staff", "refunds.manage", false],
    ["STAFF", "staff", "refunds.read", true],
    ["ADMIN", "staff", "tickets.manage", true],
    ["STAFF", "staff", "leads.manage", false],
    ["STAFF", "staff", "newsletter.send", false],
    ["ADMIN", "admin", "compliance.manage", true],
  ] as const)("%s in %s tree: %s → %s", (role, tree, surface, expected) => {
    expect(can(resolveBackofficeCapability(role, tree)!, surface)).toBe(
      expected,
    );
  });

  it("lands admin on Home and staff on the Support inbox (Q12)", () => {
    expect(backofficeLandingHref({ tree: "admin" })).toBe(
      "/dashboard/admin/home",
    );
    expect(backofficeLandingHref({ tree: "staff" })).toBe(
      "/dashboard/staff/support",
    );
  });
});

describe("staffTwinHref", () => {
  it("sends STAFF opening the admin tree to the same page in theirs", () => {
    expect(staffTwinHref("/dashboard/admin/money/payments?x=1")).toBe(
      "/dashboard/staff/money/payments?x=1",
    );
    expect(staffTwinHref("/dashboard/admin")).toBe("/dashboard/staff/support");
    expect(staffTwinHref(null)).toBe("/dashboard/staff/support");
  });
});
