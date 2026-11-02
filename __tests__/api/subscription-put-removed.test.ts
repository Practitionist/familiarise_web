/**
 * @jest-environment node
 */

/**
 * A purchased plan is immutable: the request detail routes expose no PUT (the
 * App Router answers 405), so neither party can swap the plan, its price or
 * its period after payment, and approving a subscription keeps the start the
 * buyer chose.
 */
import fs from "node:fs";
import path from "node:path";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));

const ROUTES = [
  "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
  "app/api/bookings/consultations/[consultationId]/route.ts",
];

describe("request detail routes", () => {
  it("export no PUT handler", async () => {
    const subscription =
      await import("../../app/api/bookings/subscriptions/[subscriptionId]/route");
    const consultation =
      await import("../../app/api/bookings/consultations/[consultationId]/route");
    expect("PUT" in subscription).toBe(false);
    expect("PUT" in consultation).toBe(false);
    expect(typeof subscription.PATCH).toBe("function");
    expect(typeof consultation.PATCH).toBe("function");
  });

  it.each(ROUTES)("%s never writes a plan or period", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/subscriptionPlan:\s*\w*\s*\?\s*\{\s*connect/);
    expect(source).not.toMatch(/consultationPlan:\s*\w*\s*\?\s*\{\s*connect/);
    expect(source).not.toMatch(/schedulingPeriodStartsAt:\s*startDate/);
    expect(source).not.toMatch(/schedulingPeriodEndsAt:\s*endDate/);
  });

  it("the subscription schema no longer accepts plan or period edits", async () => {
    const schemas = await import("@/schemas/subscriptions");
    expect("UpdateSubscriptionSchema" in schemas).toBe(false);
  });
});
