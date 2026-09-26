/**
 * #1771 K-2 — the staff hub is the admin hub reduced by BACKOFFICE_PERMISSIONS,
 * and a retired money URL lands on its tab with its query intact.
 */

import {
  moneyHubHref,
  moneyTabsFor,
  retiredMoneyTabHref,
} from "@/lib/backoffice/money-tabs";

it("hides the admin-only sections from staff and keeps the rest", () => {
  const staff = moneyTabsFor("STAFF").map((t) => t.key);
  expect(staff).toEqual(["payments", "refunds", "disputes", "payouts"]);
  expect(moneyTabsFor("ADMIN").map((t) => t.key)).toEqual(
    expect.arrayContaining(["earnings", "reconcile"]),
  );
});

it("carries the old query onto the hub URL", () => {
  expect(moneyHubHref("/dashboard/admin", "payouts", { tab: "earnings" })).toBe(
    "/dashboard/admin/money/payouts?tab=earnings",
  );
});

it("sends the retired class-series section to class bookings", () => {
  expect(retiredMoneyTabHref("/dashboard/staff/s1", "class-series")).toBe(
    "/dashboard/staff/s1/appointments?type=class",
  );
  expect(moneyTabsFor("ADMIN").map((t) => t.key)).not.toContain("class-series");
});
