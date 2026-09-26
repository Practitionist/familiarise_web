/**
 * @jest-environment node
 */

/**
 * #1527 Q4 — a DRAFT 1:1 or subscription plan is invisible to buyers and
 * refused for new sales, while the pay-link path for already-approved requests
 * stays open so unpublishing never strands a booking.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  eventPlanDiscoverableWhere,
  isPlanViewable,
  oneOnOnePlanDiscoverableWhere,
  planSaleRefusal,
} from "@/lib/api/plans/visibility";
import { BUSINESS_ERROR_CODES } from "@/lib/errors/classification/payment-error-classification";

const source = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("#1527 Q4 — offering plan drafts", () => {
  it("adds the status arm to the 1:1 filter only", () => {
    expect(oneOnOnePlanDiscoverableWhere()).toEqual({
      visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] },
      archivedAt: null,
      status: "PUBLISHED",
    });
    expect(eventPlanDiscoverableWhere()).not.toHaveProperty("status");
  });

  it("shows a draft to its author only", async () => {
    const member = jest.fn(async () => true);
    const draft = {
      visibility: "PUBLIC" as const,
      organizationId: "org1",
      archivedAt: null,
      consultantProfileId: "cp1",
      status: "DRAFT" as const,
    };
    await expect(isPlanViewable(draft, "u1", member, "cp1")).resolves.toBe(
      true,
    );
    await expect(isPlanViewable(draft, "u2", member, "cp2")).resolves.toBe(
      false,
    );
    await expect(isPlanViewable(draft, null, member)).resolves.toBe(false);
    await expect(
      isPlanViewable({ ...draft, status: "PUBLISHED" }, null, member),
    ).resolves.toBe(true);
  });

  it("refuses a new sale of a draft with a registered 409", () => {
    expect(planSaleRefusal({ status: "DRAFT" })).toBe("PLAN_NOT_PUBLISHED");
    expect(planSaleRefusal({ status: "PUBLISHED" })).toBeNull();
    expect(planSaleRefusal({})).toBeNull();
    expect(
      BUSINESS_ERROR_CODES.find((e) => e.code === "PLAN_NOT_PUBLISHED"),
    ).toMatchObject({
      httpStatus: 409,
      userMessage: "This plan isn't available to book right now.",
    });
  });

  it("gates checkout's assertPlanPurchasable but not approval pay-links", () => {
    const checkout = source("lib/payments/operations/checkout.ts");
    const start = checkout.indexOf("const assertPlanPurchasable = (");
    const body = checkout.slice(start, checkout.indexOf("switch (", start));
    expect(body).toMatch(/planSaleRefusal\(p\)/);
    expect(body).toMatch(/"PLAN_NOT_PUBLISHED"/);

    const approval = source("lib/payments/operations/approval-payment.ts");
    expect(approval).not.toMatch(/planSaleRefusal|PLAN_NOT_PUBLISHED/);
  });
});
