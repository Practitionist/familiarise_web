/**
 * #1771 K-2 — the staff hub is the admin hub reduced by BACKOFFICE_PERMISSIONS,
 * and a retired money URL lands on its tab with its query intact.
 */

import { moneyHubHref, moneyTabsFor } from "@/lib/backoffice/money-tabs";

it("hides the admin-only tabs from staff and keeps the rest", () => {
  const staff = moneyTabsFor("STAFF").map((t) => t.key);
  expect(staff).toEqual(
    expect.arrayContaining(["payments", "refunds", "disputes"]),
  );
  expect(staff).not.toContain("payouts");
  expect(moneyTabsFor("ADMIN").map((t) => t.key)).toContain("payouts");
});

it("carries the old query onto the hub URL", () => {
  expect(moneyHubHref("/dashboard/admin", "payouts", { tab: "earnings" })).toBe(
    "/dashboard/admin/money/payouts?tab=earnings",
  );
});
