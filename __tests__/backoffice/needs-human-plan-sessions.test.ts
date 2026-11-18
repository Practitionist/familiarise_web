/**
 * @jest-environment node
 */

/**
 * A failed support refund that removed plan sessions tells ops that a void
 * gives those sessions back; a money-only remedy says nothing about the plan.
 */
type Plan = {
  id: string;
  status: string;
  planEndsAt: string;
  startsAt: string;
};

const LIVE_PLAN: Plan = {
  id: "sub-1",
  status: "APPROVED",
  planEndsAt: "2026-12-01",
  startsAt: "2026-06-01",
};

/** An approved support refund that failed (or never went out) on a plan payment. */
const unsent = (
  id: string,
  n: number,
  amountPaise: number,
  sessionsRemoved: number | null,
  refundStatus: string | null,
  plan: Plan = LIVE_PLAN,
) => ({
  id,
  caseId: `case-${n}`,
  paymentId: `pay-${n}`,
  amountPaise,
  sessionsRemoved,
  decidedAt: new Date("2026-11-01T10:00:00Z"),
  createdAt: new Date("2026-11-01T09:00:00Z"),
  refund: refundStatus ? { status: refundStatus } : null,
  supportCase: {
    referenceNumber: `FAM-2026-${String(n + 8).padStart(6, "0")}`,
  },
  payment: {
    appointment: {
      subscription: {
        id: plan.id,
        status: plan.status,
        planEndsAt: new Date(`${plan.planEndsAt}T00:00:00Z`),
        schedulingPeriodStartsAt: new Date(`${plan.startsAt}T00:00:00Z`),
        schedulingTimezone: "UTC",
        subscriptionPlan: { durationInMonths: 6 },
      },
    },
  },
});

const rows = [
  unsent("rec-plan", 1, 180_000, 9, "FAILED"),
  unsent("rec-one", 2, 20_000, 1, null),
  unsent("rec-money", 3, 50_000, null, "FAILED"),
  unsent("rec-waiting", 5, 180_000, 9, "FAILED", {
    id: "sub-5",
    status: "APPROVED",
    planEndsAt: "2026-11-01",
    startsAt: "2026-05-01",
  }),
  unsent("rec-settled", 4, 180_000, 9, "FAILED", {
    id: "sub-4",
    status: "COMPLETED",
    planEndsAt: "2026-10-01",
    startsAt: "2026-04-01",
  }),
];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportFinancialRecommendation: { findMany: async () => rows },
  },
}));

import { readUnsentSupportRefunds } from "@/lib/backoffice/needs-human";

it("says how many sessions a void puts back on the plan", async () => {
  const items = await readUnsentSupportRefunds(
    new Date("2026-11-02T00:00:00Z"),
  );
  const byId = Object.fromEntries(items.map((i) => [i.id, i.message]));
  const detailsOf = Object.fromEntries(items.map((i) => [i.id, i.details]));
  // Record refs stay out of the message, in the item's details.
  expect(detailsOf["rec-waiting"]).toBe("Plan sub-5 · refund rec-waiting");
  expect(detailsOf["rec-money"]).toBeNull();
  for (const message of Object.values(byId))
    expect(message).not.toMatch(/sub-\d|rec-/);
  expect(byId["rec-plan"]).toBe(
    "Support case FAM-2026-000009: an approved refund of ₹1,800.00 failed. Retry or void it on the case. 9 sessions go back to the plan if you void this refund.",
  );
  expect(byId["rec-one"]).toMatch(
    /was never sent\. Retry or void it on the case\. 1 session goes back to the plan if you void this refund\.$/,
  );
  expect(byId["rec-waiting"]).toBe(
    "Support case FAM-2026-000013: an approved refund of ₹1,800.00 failed. Retry or void it on the case. 9 sessions go back to the plan if you void this refund. The plan end is waiting for this refund: retry it or void it.",
  );
  expect(byId["rec-settled"]).toBe(
    "Support case FAM-2026-000012: an approved refund of ₹1,800.00 failed. Retry or void it on the case. The plan settled without these sessions, so this refund is still owed: retry it.",
  );
  expect(byId["rec-money"]).toBe(
    "Support case FAM-2026-000011: an approved refund of ₹500.00 failed. Retry or void it on the case.",
  );
});
