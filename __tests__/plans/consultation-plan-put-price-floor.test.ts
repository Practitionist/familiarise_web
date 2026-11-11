/**
 * @jest-environment node
 */

/**
 * The consultation PUT holds only a real price or length change to the floor,
 * and saves only against the price and length it validated.
 */
jest.mock("../../lib/prisma", () => {
  const consultationPlan = {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  return {
    __esModule: true,
    default: {
      consultationPlan,
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        cb({ consultationPlan }),
      ),
    },
  };
});
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/topics", () => ({
  findOrCreateTopics: jest.fn(async () => []),
  transformTopicsToStrings: (plan: unknown) => plan,
}));
// Every text passes: these cases are about price and length only.
jest.mock("../../utils/contentValidation", () => {
  const pass = () => true;
  const fail = () => false;
  return {
    __esModule: true,
    cleanProfanity: (text: string) => text,
    containsGibberish: fail,
    containsProfanity: fail,
    hasDuplicates: fail,
    isMeaningfulText: pass,
    isProfanityFree: pass,
    validateSensibleContent: pass,
  };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { PUT } from "@/app/api/plans/consultations/[consultationPlanId]/route";

const plans = prisma.consultationPlan as unknown as {
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
};

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/plans/consultations/plan-1", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ consultationPlanId: "plan-1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  (getSession as jest.Mock).mockResolvedValue({ user: { id: "owner" } });
  // A plan saved before the floor: ₹200 for 60 minutes.
  plans.findUnique.mockResolvedValue({
    id: "plan-1",
    price: 20_000,
    durationInHours: 1,
    consultantProfile: { userId: "owner" },
  });
  plans.update.mockResolvedValue({ id: "plan-1", topics: [] });
  plans.updateMany.mockResolvedValue({ count: 1 });
});

it.each([
  ["re-sent unchanged", { price: 20_000, durationInHours: 1 }, 200],
  ["a new price", { price: 50_000, durationInHours: 1 }, 400],
  ["a new length", { price: 20_000, durationInHours: 2 }, 400],
])("an edit with %s answers %i", async (_label, terms, status) => {
  const res = await put({ title: "Renamed", ...terms });
  expect(res.status).toBe(status);
  expect(plans.update).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
});

it("answers 409 when the price or length changed after this edit read them", async () => {
  plans.updateMany.mockResolvedValue({ count: 0 });
  const res = await put({ title: "Renamed", price: 120_000 });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "PLAN_CHANGED" });
  expect(plans.updateMany).toHaveBeenCalledWith({
    where: { id: "plan-1", price: 20_000, durationInHours: 1 },
    data: { price: 120_000, durationInHours: 1 },
  });
  expect(plans.update).not.toHaveBeenCalled();
});
