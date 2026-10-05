/**
 * @jest-environment node
 */

/**
 * Referral pins: a waived order carries no promo, a second live welcome-discounted order is a
 * typed 409, a forged or stale own-link token is unattributed, a refunded referee order voids
 * or reopens by who cancelled, and the sole-admin fee-schedule self-approval waits 24 hours.
 */

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const db = {
  platformFeeSchedule: { findFirst: jest.fn() },
  referralProgramConfig: { findUnique: jest.fn(), updateMany: jest.fn() },
  expertCustomerRelationship: { findUnique: jest.fn(), deleteMany: jest.fn() },
  referral: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  referralCredit: { updateMany: jest.fn() },
  payment: { count: jest.fn(), updateMany: jest.fn() },
  consultantFeeWaiver: { findFirst: jest.fn() },
  appointmentOccurrence: { findFirst: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(db) },
}));

import { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import { feeScheduleApprovalRefusal } from "@/lib/payments/pricing/platform-fee";
import {
  asWelcomeDiscountConflict,
  resolveCheckoutAttribution,
} from "@/lib/referrals/attribution";
import {
  expertShareHref,
  verifyExpertVia,
} from "@/lib/referrals/attribution-token";
import { settleQualifyingReferral } from "@/lib/referrals/vesting";

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const typedTx = (): Promise<Tx> => prisma.$transaction(async (t) => t);

beforeEach(() => {
  jest.clearAllMocks();
  db.platformFeeSchedule.findFirst.mockResolvedValue({
    id: "fs-1",
    marketplaceBps: 2000,
    ownLinkBps: 1000,
  });
  db.referralProgramConfig.findUnique.mockResolvedValue({
    isActive: true,
    paused: false,
    monthlyBudgetPaise: 100_000,
    currentPeriod: "2026-10",
    currentMonthSpentPaise: 0,
    discountBps: 2000,
    discountMaxPaise: 30_000,
    redemptionCapBps: 2000,
    minOrderPaise: 50_000,
    qualifyWindowDays: 30,
  });
  db.expertCustomerRelationship.findUnique.mockResolvedValue(null);
  db.referral.findFirst.mockResolvedValue({
    id: "ref-1",
    referralCode: { userId: "referrer" },
  });
  db.referral.updateMany.mockResolvedValue({ count: 1 });
  db.payment.count.mockResolvedValue(0);
});

it("gives a waived order no welcome discount and no credit room", async () => {
  db.consultantFeeWaiver.findFirst.mockResolvedValue({ id: "w-1" });
  const a = await resolveCheckoutAttribution(await typedTx(), {
    buyerUserId: "buyer",
    consultantProfileId: "cp-1",
    consultantUserId: "expert",
    viaToken: null,
    orgFunded: false,
    hasDiscountCode: false,
    now: NOW,
  });
  expect(a).toMatchObject({ welcomeDiscount: null, creditCapBps: 0 });
});

it("answers a second live welcome-discounted order with a typed 409", () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: "Payment_live_welcome_discount_user_key" },
  });
  const mapped = asWelcomeDiscountConflict(p2002);
  expect(mapped).toMatchObject({ code: "WELCOME_DISCOUNT_IN_USE" });
  expect(mapped instanceof Error && classifyError(mapped).httpStatus).toBe(409);
});

it("leaves a forged, stale or secretless own-link token unattributed", () => {
  process.env.BETTER_AUTH_SECRET = "a-test-secret-of-sufficient-length";
  const token = (at: Date) =>
    decodeURIComponent(expertShareHref("cp-abcdefgh", at).split("via=")[1]);
  const fresh = token(NOW);
  expect(verifyExpertVia(fresh, NOW)).toBe("cp-abcdefgh");
  expect(verifyExpertVia(`${fresh.slice(0, -2)}xx`, NOW)).toBeNull();
  expect(
    verifyExpertVia(token(new Date(NOW.getTime() - 31 * DAY)), NOW),
  ).toBeNull();
  delete process.env.BETTER_AUTH_SECRET;
  expect(verifyExpertVia(fresh, NOW)).toBeNull();
});

describe("a refunded referee order", () => {
  const refunded = (initiatedByUserId: string | null) => ({
    id: "ref-1",
    status: "QUALIFYING",
    referredUserId: "buyer",
    qualifiedAt: NOW,
    referralCodeId: "code-1",
    referralCode: { userId: "referrer", user: { consultantProfile: null } },
    referredUser: { consultantProfile: null },
    qualifyingPayment: {
      id: "pay-1",
      userId: "buyer",
      appointmentId: "appt-1",
      appointment: { appointmentType: "CONSULTATION" },
      refunds: [{ status: "SUCCEEDED", metadata: { initiatedByUserId } }],
      disputes: [],
      earnings: [],
    },
    qualifyingOccurrence: null,
  });

  it("voids when the buyer cancelled", async () => {
    db.referral.findUnique.mockResolvedValue(refunded("buyer"));
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("VOIDED");
  });

  it("reopens inside the original window when the expert or platform cancelled", async () => {
    db.referral.findUnique.mockResolvedValue(refunded(null));
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("REOPENED");
    expect(db.referral.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "SIGNED_UP",
      qualifyingPaymentId: null,
    });
    expect(db.referralCredit.updateMany).toHaveBeenCalledWith({
      where: { referralId: "ref-1", state: "PENDING" },
      data: { state: "VOID", voidedAt: NOW },
    });
  });
});

it("lets a sole admin approve their own fee schedule only after 24 hours", () => {
  const self = {
    makerUserId: "a",
    checkerUserId: "a",
    activeAdmins: 1,
    now: NOW,
  };
  expect(
    feeScheduleApprovalRefusal({
      ...self,
      createdAt: new Date(NOW.getTime() - DAY / 2),
    }),
  ).toBe("SELF_APPROVAL_TOO_SOON");
  expect(
    feeScheduleApprovalRefusal({
      ...self,
      createdAt: new Date(NOW.getTime() - DAY),
    }),
  ).toBeNull();
});
