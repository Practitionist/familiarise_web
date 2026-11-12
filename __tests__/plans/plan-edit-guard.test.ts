/**
 * @jest-environment node
 */
import {
  assertSubscriptionPlanFloor,
  claimPlanTerms,
  editedTerms,
  planEditRefusal,
  StalePlanEditError,
} from "@/lib/api/plans/plan-edit-guard";
import { PlanPriceBelowFloorError } from "@/lib/payments/pricing/price-bounds";

const stored = { price: 20_000, durationInWeeks: 4 as number | null };

describe("plan edit guard", () => {
  it("keeps stored terms for omitted fields and flags only a real change", () => {
    expect(editedTerms(stored, { price: 20_000 })).toEqual({
      terms: stored,
      changed: false,
    });
    expect(editedTerms(stored, { durationInWeeks: null })).toEqual({
      terms: { price: 20_000, durationInWeeks: null },
      changed: true,
    });
  });

  it("refuses a stale save with a typed 409", async () => {
    await expect(claimPlanTerms(Promise.resolve({ count: 1 }))).resolves.toBe(
      undefined,
    );
    await expect(
      claimPlanTerms(Promise.resolve({ count: 0 })),
    ).rejects.toBeInstanceOf(StalePlanEditError);
  });

  it("floors only a short pack", () => {
    const plan = {
      pricePaise: 100,
      sessionDurationInHours: 1,
      totalSessions: 4,
    };
    expect(() =>
      assertSubscriptionPlanFloor({ ...plan, durationInWeeks: 4 }),
    ).toThrow(PlanPriceBelowFloorError);
    expect(() =>
      assertSubscriptionPlanFloor({ ...plan, durationInWeeks: null }),
    ).not.toThrow();
  });

  it("answers the typed refusals and passes any other error on", async () => {
    const stale = planEditRefusal(new StalePlanEditError());
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ code: "PLAN_CHANGED" });
    expect(planEditRefusal(new PlanPriceBelowFloorError(1, "x"))?.status).toBe(
      400,
    );
    expect(planEditRefusal(new Error("boom"))).toBeNull();
  });
});
