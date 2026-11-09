/**
 * @jest-environment node
 */

/**
 * The subscription plan PUT spares what clients already bought: it stamps the
 * sold rows' terms from the plan BEFORE it changes the plan, answers with how
 * many active clients keep their terms, and refuses to switch a sold plan
 * between months and weeks.
 */
const order: string[] = [];
const sold = { count: 3 };
const tx = {
  subscriptionContent: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  subscriptionPlan: {
    findUnique: jest.fn(async () => {
      order.push("read-plan");
      return {
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
        totalSessions: 8,
        durationInMonths: 1,
        durationInWeeks: null,
      };
    }),
    update: jest.fn(async () => {
      order.push("update-plan");
      return { id: "plan-1", topics: [] };
    }),
  },
  subscription: {
    // The unit lock counts buyers inside the edit's transaction.
    count: jest.fn(async () => sold.count),
    findMany: jest.fn(async () => {
      order.push("read-unended");
      return [
        {
          id: "sub-legacy",
          schedulingPeriodStartsAt: new Date("2026-01-31T04:30:00.000Z"),
          schedulingTimezone: "Asia/Kolkata",
        },
      ];
    }),
    updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
      order.push(`stamp:${Object.keys(args.data).join(",")}`);
      return { count: 1 };
    }),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    subscriptionPlan: { findUnique: jest.fn() },
    subscription: { count: jest.fn() },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  },
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/booking/feasibility", () => ({
  planPublishFeasibility: jest.fn(async () => ({
    refusal: null,
    warnings: [],
  })),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/data/plan-details", () => ({}));
jest.mock("../../lib/topics", () => ({
  findOrCreateTopics: jest.fn(async () => []),
  transformTopicsToStrings: (plan: unknown) => plan,
}));
jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  containsGibberish: () => false,
  containsProfanity: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
  validateSensibleContent: () => true,
  cleanProfanity: (text: string) => text,
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { planEndOf } from "@/lib/booking/entitlement";
import { planPublishFeasibility } from "@/lib/booking/feasibility";
import { PUT } from "@/app/api/plans/subscriptions/[subscriptionPlanId]/route";

const db = prisma as unknown as {
  subscriptionPlan: { findUnique: jest.Mock };
  subscription: { count: jest.Mock };
};

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/plans/subscriptions/plan-1", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ subscriptionPlanId: "plan-1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  (getSession as jest.Mock).mockResolvedValue({ user: { id: "owner" } });
  db.subscriptionPlan.findUnique.mockResolvedValue({
    id: "plan-1",
    sessionsPerWeek: 2,
    sessionDurationInHours: 1,
    durationInMonths: 1,
    durationInWeeks: null,
    trialEnabled: false,
    trialPriceInPaise: 0,
    status: "PUBLISHED",
    consultantProfileId: "profile-1",
    consultantProfile: { userId: "owner" },
  });
  db.subscription.count.mockResolvedValue(3);
  sold.count = 3;
});

it("stamps sold rows (cadence, length, total, end) before the plan changes", async () => {
  const res = await put({ sessionsPerWeek: 5, durationInMonths: 2 });
  expect(res.status).toBe(200);
  expect(order.indexOf("update-plan")).toBeGreaterThan(-1);
  const stamps = order.filter((step) => step.startsWith("stamp:"));
  expect(stamps).toEqual([
    "stamp:planEndsAt",
    "stamp:sessionsPerWeek",
    "stamp:sessionMinutes",
    "stamp:sessionsTotal",
  ]);
  expect(order.lastIndexOf("stamp:sessionsTotal")).toBeLessThan(
    order.indexOf("update-plan"),
  );
  // The end comes from the length sold (1 month), not the edit's 2.
  expect(tx.subscription.updateMany).toHaveBeenCalledWith({
    where: { id: "sub-legacy", planEndsAt: null },
    data: {
      planEndsAt: planEndOf(
        new Date("2026-01-31T04:30:00.000Z"),
        1,
        "Asia/Kolkata",
      ),
    },
  });
  const body = await res.json();
  expect(body).toMatchObject({
    activeClients: 3,
    notice:
      "3 active clients keep their current terms. Changes apply to new buyers only.",
  });
});

it("refuses to switch a sold months plan to weeks", async () => {
  const res = await put({ durationInWeeks: 26 });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "PLAN_LENGTH_UNIT_LOCKED" });
  expect(tx.subscription.count).toHaveBeenCalled();
  expect(tx.subscriptionPlan.update).not.toHaveBeenCalled();
});

it("lets an unsold months plan move to weeks", async () => {
  db.subscription.count.mockResolvedValue(0);
  sold.count = 0;
  const res = await put({ durationInWeeks: 26 });
  expect(res.status).toBe(200);
  expect(tx.subscriptionPlan.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        durationInWeeks: 26,
        durationInMonths: 6,
      }),
    }),
  );
});

it("refuses a terms edit the published hours can't deliver, before writing", async () => {
  (planPublishFeasibility as jest.Mock).mockResolvedValueOnce({
    refusal: {
      status: 422,
      body: {
        error: "can't be delivered",
        code: "PLAN_NOT_FEASIBLE",
        reasons: [],
      },
    },
    warnings: [],
  });
  const res = await put({ sessionsPerWeek: 7 });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ code: "PLAN_NOT_FEASIBLE" });
  expect(planPublishFeasibility).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      consultantProfileId: "profile-1",
      sessionsPerWeek: 7,
      sessionMinutes: 60,
      perDayCap: 1,
      publishing: true,
    }),
  );
  expect(tx.subscriptionPlan.update).not.toHaveBeenCalled();
});

it("never re-polices a published plan on an edit that leaves its terms alone", async () => {
  const res = await put({ title: "A clearer title for the plan" });
  expect(res.status).toBe(200);
  expect(planPublishFeasibility).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ publishing: false }),
  );
});
