/**
 * A session-count remedy can only take sessions off a live plan before its end
 * with no owed refund marker; a void gives sessions back only to a plan that
 * has not completed or been cancelled, and never more than were removed.
 */
import type { Tx } from "../../lib/prisma";
import {
  planRefundBasis,
  removePlanSessions,
  restorePlanSessions,
} from "../../lib/booking/plan-refund";

const NOW = new Date("2026-03-10T09:00:00.000Z");

function txFor(over: {
  status?: string;
  planEndsAt?: Date;
  refundOwedKey?: string | null;
  sessionsRefunded?: number;
}) {
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const tx = {
    payment: {
      findUnique: jest.fn(async () => ({
        refundOwedKey: over.refundOwedKey ?? null,
        appointment: {
          subscription: {
            id: "sub-1",
            status: over.status ?? "APPROVED",
            sessionsTotal: 8,
            sessionsPerWeek: 2,
            sessionsRefunded: over.sessionsRefunded ?? 0,
            schedulingPeriodStartsAt: new Date("2026-03-02T00:00:00.000Z"),
            schedulingTimezone: "UTC",
            planEndsAt: over.planEndsAt ?? new Date("2026-03-30T00:00:00.000Z"),
            subscriptionPlan: {
              totalSessions: 8,
              sessionsPerWeek: 2,
              durationInMonths: 1,
            },
          },
          occurrences: [],
        },
      })),
    },
    subscription: { updateMany },
  };
  return { tx: tx as unknown as Tx, updateMany };
}

describe("planRefundBasis", () => {
  it("offers every unheld session on an open plan", async () => {
    const basis = await planRefundBasis(txFor({}).tx, "pay-1", NOW);
    expect(basis).toMatchObject({ open: true, live: true, removable: 8 });
  });

  it.each([
    ["cancelled", { status: "CANCELLED" }],
    ["completed", { status: "COMPLETED" }],
    ["ended", { planEndsAt: new Date("2026-03-09T00:00:00.000Z") }],
    ["owing a refund", { refundOwedKey: "plan-end:sub-1:pay:pay-1" }],
  ])("offers nothing on a plan %s", async (_label, over) => {
    const basis = await planRefundBasis(txFor(over).tx, "pay-1", NOW);
    expect(basis).toMatchObject({ open: false, removable: 0 });
  });
});

describe("removePlanSessions", () => {
  it("refuses a closed plan without writing", async () => {
    const { tx, updateMany } = txFor({ status: "CANCELLED" });
    await expect(removePlanSessions(tx, "pay-1", 1)).resolves.toEqual({
      ok: false,
      reason: "PLAN_CLOSED",
      removable: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("restorePlanSessions", () => {
  it("leaves a settled plan's count alone", async () => {
    const { tx, updateMany } = txFor({ status: "COMPLETED", sessionsRefunded: 3 });
    await expect(restorePlanSessions(tx, "pay-1", 3)).resolves.toEqual({
      ok: true,
      sessionsRefunded: 3,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses to give back more sessions than were removed", async () => {
    const { tx, updateMany } = txFor({ sessionsRefunded: 2 });
    await expect(restorePlanSessions(tx, "pay-1", 3)).resolves.toMatchObject({
      ok: false,
      reason: "NOT_REMOVED",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("gives back by CAS on the count it read", async () => {
    const { tx, updateMany } = txFor({ sessionsRefunded: 3 });
    await expect(restorePlanSessions(tx, "pay-1", 3)).resolves.toEqual({
      ok: true,
      sessionsRefunded: 0,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", sessionsRefunded: 3 },
      data: { sessionsRefunded: 0 },
    });
  });
});
