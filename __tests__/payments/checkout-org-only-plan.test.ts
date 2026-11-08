/**
 * @jest-environment node
 */

// An ORG_ONLY plan sells only when the plan's org and the buyer's sponsoring org are both set and equal.

const consultationPlan = { findUnique: jest.fn() };
const tx = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "buyer",
      consulteeProfile: { id: "ce-1", billingStateCode: null },
    })),
  },
  consultationPlan,
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  ensureConsulteeProfile: jest.fn(async () => undefined),
}));

import { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import type { CheckoutInput } from "@/schemas/checkout";

const plan = (organizationId: string | null) => ({
  id: "plan-1",
  archivedAt: null,
  visibility: "ORG_ONLY",
  organizationId,
  status: "PUBLISHED",
  consultantProfile: {
    id: "cp-1",
    deletedAt: null,
    verificationStatus: "VERIFIED",
    acceptingRequests: true,
    user: { id: "u-host" },
  },
});

// No window, so a plan that clears the org gate stops at the next check.
const price = (organizationId?: string) => {
  const input: CheckoutInput = {
    appointmentType: "CONSULTATION",
    planId: "plan-1",
    paymentGateway: "RAZORPAY",
    organizationId,
  };
  return calculateAmountAndValidate(input, "buyer");
};

it.each([
  ["a different org", "org-a", "org-b"],
  ["a null plan org", null, "org-b"],
  ["a null buyer org", "org-a", undefined],
])(
  "refuses %s with PLAN_NOT_AVAILABLE_TO_ORG (409)",
  async (_, planOrg, buyerOrg) => {
    consultationPlan.findUnique.mockResolvedValueOnce(plan(planOrg));
    const error = await price(buyerOrg).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PLAN_NOT_AVAILABLE_TO_ORG" });
    expect(classifyError(error)).toMatchObject({
      httpStatus: 409,
      isBusinessError: true,
    });
  },
);

it("lets the same org through the visibility gate", async () => {
  consultationPlan.findUnique.mockResolvedValueOnce(plan("org-a"));
  await expect(price("org-a")).rejects.toMatchObject({
    code: "WINDOW_DURATION_MISMATCH",
  });
});
