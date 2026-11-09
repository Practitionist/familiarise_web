/**
 * @jest-environment node
 */

// A discount code on an order whose take cannot fund promo (a live fee waiver or a host-org
// seller) is refused in pricing with DISCOUNT_NOT_APPLICABLE, so commit never spends a use.

const tx = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "buyer",
      consulteeProfile: { id: "ce-1", billingStateCode: null },
    })),
  },
  subscriptionPlan: { findUnique: jest.fn() },
  discountCode: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  platformFeeSchedule: { findFirst: jest.fn() },
  referralProgramConfig: { findUnique: jest.fn() },
  expertCustomerRelationship: { findUnique: jest.fn() },
  consultantFeeWaiver: { findFirst: jest.fn() },
  membership: { findFirst: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  ensureConsulteeProfile: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/checkout/occupancy-validate", () => ({
  validateSlotAvailability: jest.fn(async () => undefined),
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_HOST_ORGS: true,
}));

import { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import type { CheckoutInput } from "@/schemas/checkout";

const input: CheckoutInput = {
  appointmentType: "SUBSCRIPTION",
  planId: "plan-1",
  paymentGateway: "RAZORPAY",
  discountCode: "save10",
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.subscriptionPlan.findUnique.mockResolvedValue({
    id: "plan-1",
    price: 100_000,
    priceCurrency: "INR",
    archivedAt: null,
    visibility: "PUBLIC",
    organizationId: null,
    status: "PUBLISHED",
    consultantProfile: {
      id: "cp-1",
      userId: "u-host",
      deletedAt: null,
      verificationStatus: "VERIFIED",
      acceptingRequests: true,
      user: { id: "u-host" },
    },
  });
  tx.discountCode.findUnique.mockResolvedValue({
    id: "dc-1",
    isActive: true,
    expiresAt: null,
    maxUses: 100,
    currentUses: 3,
    discountType: "PERCENTAGE",
    discountValue: 10,
    maxDiscount: null,
    currency: null,
  });
  tx.platformFeeSchedule.findFirst.mockResolvedValue({
    id: "fs-1",
    marketplaceBps: 2000,
    ownLinkBps: 1000,
  });
  tx.referralProgramConfig.findUnique.mockResolvedValue(null);
  tx.expertCustomerRelationship.findUnique.mockResolvedValue(null);
  tx.consultantFeeWaiver.findFirst.mockResolvedValue(null);
  tx.membership.findFirst.mockResolvedValue(null);
});

it.each([
  [
    "a live fee waiver",
    () => tx.consultantFeeWaiver.findFirst.mockResolvedValue({ id: "w-1" }),
  ],
  [
    "a host-organisation seller",
    () => tx.membership.findFirst.mockResolvedValue({ id: "m-1" }),
  ],
])(
  "refuses a code on %s with DISCOUNT_NOT_APPLICABLE (409) before commit",
  async (_, arrange) => {
    arrange();
    const error = await calculateAmountAndValidate(input, "buyer").catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "DISCOUNT_NOT_APPLICABLE",
      httpStatus: 409,
    });
    expect(classifyError(error)).toMatchObject({ httpStatus: 409 });
    expect(tx.discountCode.update).not.toHaveBeenCalled();
    expect(tx.discountCode.updateMany).not.toHaveBeenCalled();
  },
);

it("prices the same code on a marketplace order whose take funds promo", async () => {
  const priced = await calculateAmountAndValidate(input, "buyer");
  expect(priced.discountCodeId).toBe("dc-1");
  expect(priced.amount).toBeLessThan(priced.originalAmount + priced.taxAmount);
  expect(tx.discountCode.update).not.toHaveBeenCalled();
});

it("does not refuse a waived order that carries no code", async () => {
  tx.consultantFeeWaiver.findFirst.mockResolvedValue({ id: "w-1" });
  const priced = await calculateAmountAndValidate(
    { ...input, discountCode: undefined },
    "buyer",
  );
  expect(priced.discountCodeId).toBeNull();
});
