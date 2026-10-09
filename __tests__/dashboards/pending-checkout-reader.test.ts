/**
 * @jest-environment node
 */

/**
 * The pending-checkout read puts the viewer in the WHERE: another user's
 * payment never comes back, and the select names only rendered columns.
 */

type Where = { id: string; userId: string };
const getUserCreditsMock = jest.fn(async () => ({ totalAvailable: 0 }));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  getUserCredits: () => getUserCreditsMock(),
}));

const ROWS: Array<Record<string, unknown>> = [
  {
    id: "pay-owner",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 11800,
    originalAmount: 10000,
    taxAmount: 1800,
    currency: "INR",
    buyerCountry: "IN",
    welcomeDiscountPaise: null,
    expiresAt: null,
    appointmentId: "apt-1",
    discountCode: null,
    creditUsages: [],
    legs: [],
    user: { id: "user-owner", consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
  {
    id: "pay-single-use-coupon",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 9440,
    originalAmount: 10000,
    taxAmount: 1440,
    currency: "INR",
    buyerCountry: "IN",
    welcomeDiscountPaise: null,
    expiresAt: null,
    appointmentId: "apt-2",
    discountCode: {
      code: "SOLO20",
      discountType: "PERCENTAGE",
      discountValue: 20,
      maxDiscount: null,
      isActive: true,
      expiresAt: null,
      maxUses: 1,
      currentUses: 1,
    },
    creditUsages: [],
    legs: [],
    user: { id: "user-owner", consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
  {
    id: "pay-exhausted-coupon",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 9440,
    originalAmount: 10000,
    taxAmount: 1440,
    currency: "INR",
    buyerCountry: "IN",
    welcomeDiscountPaise: null,
    expiresAt: null,
    appointmentId: "apt-3",
    discountCode: {
      code: "OVERBOOKED",
      discountType: "PERCENTAGE",
      discountValue: 20,
      maxDiscount: null,
      isActive: true,
      expiresAt: null,
      maxUses: 1,
      currentUses: 2,
    },
    creditUsages: [],
    legs: [],
    user: { id: "user-owner", consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
  {
    id: "pay-held-credits",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 6800,
    originalAmount: 10000,
    taxAmount: 1800,
    currency: "INR",
    buyerCountry: "IN",
    welcomeDiscountPaise: null,
    expiresAt: null,
    appointmentId: "apt-4",
    discountCode: null,
    creditUsages: [
      {
        amount: 5000,
        credit: { state: "VESTED", expiresAt: null },
      },
    ],
    legs: [{ amountPaise: 5000 }],
    user: { id: "user-owner", consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
  {
    id: "pay-expired-credits",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 6800,
    originalAmount: 10000,
    taxAmount: 1800,
    currency: "INR",
    buyerCountry: "IN",
    welcomeDiscountPaise: null,
    expiresAt: null,
    appointmentId: "apt-5",
    discountCode: null,
    creditUsages: [
      {
        amount: 5000,
        credit: {
          state: "VESTED",
          expiresAt: new Date("2020-01-01T00:00:00Z"),
        },
      },
    ],
    legs: [{ amountPaise: 5000 }],
    user: { id: "user-owner", consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
];

const findFirst = jest.fn(async ({ where }: { where: Where }) => {
  return (
    ROWS.find((r) => r.id === where.id && r.userId === where.userId) ?? null
  );
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { payment: { findFirst: (arg: never) => findFirst(arg) } },
}));

import { readPendingCheckout } from "@/lib/data/pending-checkout";

it("returns the viewer's own charge with a derived breakdown", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-owner",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-owner",
    basePaise: 10000,
    taxPaise: 1800,
    totalPaise: 11800,
    discountPaise: 0,
    creditsPaise: 0,
    currentTotalPaise: 11800,
    quoteStaleReason: null,
    consulteeProfileId: "ce-owner",
  });
});

it("does not self-exhaust a single-use coupon reserved on the current PENDING payment", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-single-use-coupon",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-single-use-coupon",
    discountCode: "SOLO20",
    totalPaise: 9440,
    currentTotalPaise: 9440,
    quoteStaleReason: null,
  });
});

it("flags COUPON_EXHAUSTED when other checkouts exceeded maxUses", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-exhausted-coupon",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-exhausted-coupon",
    quoteStaleReason: "COUPON_EXHAUSTED",
    currentTotalPaise: 11800,
  });
});

it("does not flag CREDITS_SHORT when credits are held in valid VESTED creditUsages even if remaining wallet is zero", async () => {
  getUserCreditsMock.mockResolvedValueOnce({ totalAvailable: 0 });
  const out = await readPendingCheckout({
    paymentId: "pay-held-credits",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-held-credits",
    creditsPaise: 5000,
    quoteStaleReason: null,
  });
  expect(getUserCreditsMock).not.toHaveBeenCalled();
});

it("flags CREDITS_SHORT when held credits expired and wallet balance cannot cover the shortfall", async () => {
  getUserCreditsMock.mockResolvedValueOnce({ totalAvailable: 1000 });
  const out = await readPendingCheckout({
    paymentId: "pay-expired-credits",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-expired-credits",
    creditsPaise: 5000,
    quoteStaleReason: "CREDITS_SHORT",
  });
});

it("never returns another user's payment", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-owner",
    viewerUserId: "user-intruder",
  });
  expect(out).toBeNull();
  const call = findFirst.mock.calls.at(-1)?.[0] as unknown as {
    where: { userId: string };
    select: Record<string, unknown>;
  };
  expect(call.where.userId).toBe("user-intruder");
  expect(call.select).not.toHaveProperty("paymentIntent");
  expect(call.select).not.toHaveProperty("gatewayPaymentId");
});
