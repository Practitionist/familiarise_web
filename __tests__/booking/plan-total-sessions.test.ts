/**
 * @jest-environment node
 */

/**
 * An N-month plan holds sessionsPerWeek × N × 4 sessions, from one helper
 * every class plan writer uses, whatever the creation date or server zone; a
 * 1:1 plan holds weeks × sessionsPerWeek through `subscriptionPlanTotals`.
 */
import fs from "node:fs";
import path from "node:path";

import { planTotalSessions } from "@/lib/booking/entitlement";

describe("planTotalSessions", () => {
  it.each([
    [1, 1, 4],
    [2, 3, 24],
    [3, 6, 72],
  ])("%i per week for %i months holds %i sessions", (spw, months, total) => {
    expect(
      planTotalSessions({ sessionsPerWeek: spw, durationInMonths: months }),
    ).toBe(total);
  });

  it.each([
    "app/api/plans/subscriptions/route.ts",
    "app/api/plans/subscriptions/[subscriptionPlanId]/route.ts",
  ])("%s derives a 1:1 plan's totals from its weeks", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).toContain("subscriptionPlanTotals(");
    expect(source).not.toMatch(/countWeeks|durationInMonths \* 4/);
  });

  it.each([
    "app/api/bookings/classes/crud-with-plan/route.ts",
    "app/api/plans/classes/route.ts",
    "app/api/organizations/[orgId]/catalog/route.ts",
  ])("%s derives totalSessions through the helper", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).toContain("planTotalSessions(");
    expect(source).not.toMatch(/countWeeks|durationInMonths \* 4/);
  });
});
