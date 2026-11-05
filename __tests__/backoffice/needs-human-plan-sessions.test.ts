/**
 * @jest-environment node
 */

/**
 * A failed support refund that removed plan sessions tells ops that a void
 * gives those sessions back; a money-only remedy says nothing about the plan.
 */
const rows = [
  {
    id: "rec-plan",
    caseId: "case-1",
    paymentId: "pay-1",
    amountPaise: 180_000,
    sessionsRemoved: 9,
    decidedAt: new Date("2026-11-01T10:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    refund: { status: "FAILED" },
    supportCase: { referenceNumber: "FAM-2026-000009" },
    payment: {
      appointment: {
        subscription: {
          id: "sub-1",
          status: "APPROVED",
          planEndsAt: new Date("2026-12-01T00:00:00Z"),
          schedulingPeriodStartsAt: new Date("2026-06-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: { durationInMonths: 6 },
        },
      },
    },
  },
  {
    id: "rec-one",
    caseId: "case-2",
    paymentId: "pay-2",
    amountPaise: 20_000,
    sessionsRemoved: 1,
    decidedAt: new Date("2026-11-01T10:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    refund: null,
    supportCase: { referenceNumber: "FAM-2026-000010" },
    payment: {
      appointment: {
        subscription: {
          id: "sub-1",
          status: "APPROVED",
          planEndsAt: new Date("2026-12-01T00:00:00Z"),
          schedulingPeriodStartsAt: new Date("2026-06-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: { durationInMonths: 6 },
        },
      },
    },
  },
  {
    id: "rec-money",
    caseId: "case-3",
    paymentId: "pay-3",
    amountPaise: 50_000,
    sessionsRemoved: null,
    decidedAt: new Date("2026-11-01T10:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    refund: { status: "FAILED" },
    supportCase: { referenceNumber: "FAM-2026-000011" },
    payment: {
      appointment: {
        subscription: {
          id: "sub-1",
          status: "APPROVED",
          planEndsAt: new Date("2026-12-01T00:00:00Z"),
          schedulingPeriodStartsAt: new Date("2026-06-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: { durationInMonths: 6 },
        },
      },
    },
  },
  {
    id: "rec-waiting",
    caseId: "case-5",
    paymentId: "pay-5",
    amountPaise: 180_000,
    sessionsRemoved: 9,
    decidedAt: new Date("2026-11-01T10:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    refund: { status: "FAILED" },
    supportCase: { referenceNumber: "FAM-2026-000013" },
    payment: {
      appointment: {
        subscription: {
          id: "sub-5",
          status: "APPROVED",
          planEndsAt: new Date("2026-11-01T00:00:00Z"),
          schedulingPeriodStartsAt: new Date("2026-05-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: { durationInMonths: 6 },
        },
      },
    },
  },
  {
    id: "rec-settled",
    caseId: "case-4",
    paymentId: "pay-4",
    amountPaise: 180_000,
    sessionsRemoved: 9,
    decidedAt: new Date("2026-11-01T10:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    refund: { status: "FAILED" },
    supportCase: { referenceNumber: "FAM-2026-000012" },
    payment: {
      appointment: {
        subscription: {
          id: "sub-4",
          status: "COMPLETED",
          planEndsAt: new Date("2026-10-01T00:00:00Z"),
          schedulingPeriodStartsAt: new Date("2026-04-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: { durationInMonths: 6 },
        },
      },
    },
  },
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
  expect(byId["rec-plan"]).toBe(
    "Support case FAM-2026-000009: an approved refund of ₹1800.00 failed. Retry or void it on the case. 9 sessions go back to the plan if you void this refund.",
  );
  expect(byId["rec-one"]).toMatch(
    /was never sent\. Retry or void it on the case\. 1 session goes back to the plan if you void this refund\.$/,
  );
  expect(byId["rec-waiting"]).toBe(
    "Support case FAM-2026-000013: an approved refund of ₹1800.00 failed. Retry or void it on the case. 9 sessions go back to the plan if you void this refund. Plan end for plan sub-5 is waiting for refund rec-waiting: retry it or void it.",
  );
  expect(byId["rec-settled"]).toBe(
    "Support case FAM-2026-000012: an approved refund of ₹1800.00 failed. Retry or void it on the case. The plan settled without these sessions, so this refund is still owed: retry it.",
  );
  expect(byId["rec-money"]).toBe(
    "Support case FAM-2026-000011: an approved refund of ₹500.00 failed. Retry or void it on the case.",
  );
});
