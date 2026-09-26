/**
 * #1527 Q3 — one back-office route tree. Pins the capability matrix (tree =
 * audience, role caps it) and every retired URL's new home.
 */

import {
  backofficeLandingHref,
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";
import {
  legacyBackofficeHref,
  staffTwinHref,
} from "@/lib/backoffice/legacy-routes";

const UUID = "3f2b8c1e-9a4d-4e6b-8f0a-1c2d3e4f5a6b";

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

  it("lands admin on Home and staff on Tickets (Q12)", () => {
    expect(backofficeLandingHref({ tree: "admin" })).toBe(
      "/dashboard/admin/home",
    );
    expect(backofficeLandingHref({ tree: "staff" })).toBe(
      "/dashboard/staff/tickets",
    );
  });
});

describe("legacyBackofficeHref", () => {
  it.each([
    ["staff", [UUID], {}, "/dashboard/staff/tickets"],
    [
      "staff",
      [UUID, "money", "payouts"],
      { tab: "x" },
      "/dashboard/staff/money/payouts?tab=x",
    ],
    [
      "staff",
      [UUID, "approval-payments"],
      {},
      "/dashboard/staff/appointments?tab=awaiting-payment",
    ],
    [
      "admin",
      ["approval-payments"],
      { page: "2" },
      "/dashboard/admin/appointments?page=2&tab=awaiting-payment",
    ],
    ["staff", ["documents"], {}, "/dashboard/staff/verification?tab=documents"],
    ["admin", ["feedbacks"], {}, "/dashboard/admin/feedback"],
    [
      "admin",
      ["data-breaches"],
      {},
      "/dashboard/admin/compliance?tab=breaches",
    ],
    [
      "admin",
      ["data-breaches", "b1"],
      {},
      "/dashboard/admin/compliance?tab=breaches&id=b1",
    ],
    ["admin", [], {}, "/dashboard/admin/home"],
  ] as const)("%s %j %j → %s", (tree, segments, query, expected) => {
    expect(legacyBackofficeHref(tree, segments, query)).toBe(expected);
  });

  it("404s anything unknown, including a UUID outside the staff tree", () => {
    expect(legacyBackofficeHref("admin", ["nope"])).toBeNull();
    expect(legacyBackofficeHref("admin", [UUID])).toBeNull();
    expect(legacyBackofficeHref("staff", [UUID, "nope", "deeper"])).toBe(
      "/dashboard/staff/nope/deeper",
    );
  });

  it("sends STAFF opening the admin tree to the same page in theirs", () => {
    expect(staffTwinHref("/dashboard/admin/money/payments?x=1")).toBe(
      "/dashboard/staff/money/payments?x=1",
    );
    expect(staffTwinHref("/dashboard/admin")).toBe("/dashboard/staff/tickets");
    expect(staffTwinHref(null)).toBe("/dashboard/staff/tickets");
  });
});
