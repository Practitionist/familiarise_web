/**
 * @jest-environment node
 */

// A reload or second tab prices as if the buyer's own open order for the same
// item were released: its referral credit counts as available and its use of a
// code does not exhaust the code. Another buyer's open order still does.

const tx = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "buyer",
      consulteeProfile: { id: "ce-1", billingStateCode: null },
    })),
  },
  subscriptionPlan: { findUnique: jest.fn() },
  discountCode: { findUnique: jest.fn() },
  payment: { findMany: jest.fn() },
  referralCredit: { findMany: jest.fn() },
  referralCreditUsage: { aggregate: jest.fn() },
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

import { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import {
  findReusablePendingOrderPayment,
  openOrderTargetOf,
} from "@/lib/payments/checkout/order-reuse";
import type { CheckoutInput } from "@/schemas/checkout";

// The page sends its load time as the start, which the server clamps to "now".
const input: CheckoutInput = {
  appointmentType: "SUBSCRIPTION",
  planId: "plan-1",
  paymentGateway: "RAZORPAY",
  schedulingPeriodStartsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
};
const openedAt = new Date(Date.now() - 10 * 60_000);

/** The buyer's own unpaid order for this plan, as the reuse lookup reads it. */
const openOrder = (amount: number, discountCodeId: string | null = null) => ({
  id: "pay-open",
  paymentIntent: "order_open",
  amount,
  currency: "INR",
  isMockPayment: false,
  expiresAt: new Date(Date.now() + 20 * 60_000),
  discountCodeId,
  appointment: {
    occurrences: [],
    // A "start now" order: its start is the instant it was created.
    subscription: {
      schedulingPeriodStartsAt: openedAt,
      schedulingPeriodEndsAt: new Date(openedAt.getTime() + 7 * 86_400_000),
      createdAt: openedAt,
      renewedFromSubscriptionId: null,
    },
    participants: [],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  tx.subscriptionPlan.findUnique.mockResolvedValue({
    id: "plan-1",
    price: 299_047,
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
  tx.payment.findMany.mockResolvedValue([]);
  tx.referralCredit.findMany.mockResolvedValue([]);
  tx.referralCreditUsage.aggregate.mockResolvedValue({
    _sum: { amount: null },
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

it("prices a start-now reload with credits like the first tab, so the open order is reused", async () => {
  const withCredits = { ...input, useReferralCredits: true };
  tx.referralCredit.findMany.mockResolvedValue([{ remainingAmount: 20_000 }]);
  const first = await calculateAmountAndValidate(withCredits, "buyer");
  expect(first.creditsApplied).toBe(20_000);

  // The first order now holds the ₹200; the balance reads 0.
  const held = openOrder(first.amount);
  tx.referralCredit.findMany.mockResolvedValue([]);
  tx.payment.findMany.mockResolvedValue([held]);
  tx.referralCreditUsage.aggregate.mockResolvedValue({
    _sum: { amount: BigInt(20_000) },
  });
  const reload = await calculateAmountAndValidate(withCredits, "buyer");
  expect(reload.amount).toBe(first.amount);

  const { reusable, supersede } = await findReusablePendingOrderPayment(
    tx as never,
    {
      ...openOrderTargetOf(
        withCredits,
        "buyer",
        null,
        reload.subscriptionSchedulingPeriod,
      )!,
      expectedAmountPaise: reload.amount,
      expectedDiscountCodeId: reload.discountCodeId,
    },
  );
  expect(reusable?.id).toBe("pay-open");
  expect(supersede).toEqual([]);
});

it("does not count or supersede a start-now order for a checkout with a chosen later start", async () => {
  const later = {
    ...input,
    useReferralCredits: true,
    schedulingPeriodStartsAt: new Date(
      Date.now() + 3 * 86_400_000,
    ).toISOString(),
  };
  tx.payment.findMany.mockResolvedValue([openOrder(279_047)]);
  tx.referralCreditUsage.aggregate.mockResolvedValue({
    _sum: { amount: BigInt(20_000) },
  });
  const priced = await calculateAmountAndValidate(later, "buyer");
  expect(priced.creditsApplied).toBe(0);
  const { reusable, supersede } = await findReusablePendingOrderPayment(
    tx as never,
    {
      ...openOrderTargetOf(
        later,
        "buyer",
        null,
        priced.subscriptionSchedulingPeriod,
      )!,
      expectedAmountPaise: 279_047,
      expectedDiscountCodeId: null,
    },
  );
  expect(reusable).toBeNull();
  expect(supersede).toEqual([]);
});

it("does not let the buyer's own open order exhaust a one-use code; another buyer's does", async () => {
  tx.discountCode.findUnique.mockResolvedValue({
    id: "dc-1",
    isActive: true,
    expiresAt: null,
    maxUses: 1,
    currentUses: 1,
    discountType: "PERCENTAGE",
    discountValue: 10,
    maxDiscount: null,
    currency: null,
  });
  const withCode = { ...input, discountCode: "once" };

  tx.payment.findMany.mockResolvedValue([openOrder(269_142, "dc-1")]);
  const own = await calculateAmountAndValidate(withCode, "buyer");
  expect(own.discountCodeId).toBe("dc-1");

  // The lookup is the buyer's own orders only, so another buyer's use finds nothing.
  tx.payment.findMany.mockResolvedValue([]);
  await expect(
    calculateAmountAndValidate(withCode, "second-buyer"),
  ).rejects.toMatchObject({ name: "DiscountExhaustedError" });
  expect(tx.payment.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ userId: "second-buyer" }),
    }),
  );
});
