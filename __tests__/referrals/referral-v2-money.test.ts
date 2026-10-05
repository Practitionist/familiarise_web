/**
 * @jest-environment node
 */

/**
 * Referral money edges: take rate by attribution and waiver consumption, the vest CAS
 * (refund present, void on refund, budget exhaustion, liability journal) and the credit cap.
 */

const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const tx = {
  referral: { findUnique: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  referralProgramConfig: { findUnique: jest.fn(), updateMany: jest.fn() },
  referralCredit: {
    findFirst: jest.fn(),
    aggregate: jest.fn(),
    updateMany: jest.fn(),
  },
  referralCode: { updateMany: jest.fn(), findUnique: jest.fn() },
  appointmentOccurrence: { findFirst: jest.fn(), findUnique: jest.fn() },
  platformFeeSchedule: { findFirst: jest.fn() },
  consultantFeeWaiver: { findFirst: jest.fn(), updateMany: jest.fn() },
  expertCustomerRelationship: { findUnique: jest.fn() },
  payment: { updateMany: jest.fn(), findFirst: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));

import prisma, { type Tx } from "@/lib/prisma";
import { settleB2cPlatformFeePaise } from "@/lib/payments/pricing/platform-fee";
import { deriveCheckoutAmount } from "@/lib/payments/pricing/derive-checkout-amount";
import { settleQualifyingReferral } from "@/lib/referrals/vesting";

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
/** The mocked client hands the stub to its callback, typed as the real transaction client. */
const typedTx = (): Promise<Tx> => prisma.$transaction(async (t) => t);
let T: Tx;
beforeAll(async () => {
  T = await typedTx();
});

const config = (over: Record<string, unknown> = {}) => ({
  id: "singleton",
  isActive: true,
  paused: false,
  monthlyBudgetPaise: 100_000,
  currentPeriod: "2026-10",
  currentMonthSpentPaise: 0,
  referrerRewardPaise: 30_000,
  discountBps: 2000,
  discountMaxPaise: 30_000,
  redemptionCapBps: 2000,
  minOrderPaise: 50_000,
  creditExpiryDays: 90,
  qualifyWindowDays: 30,
  perCodeLifetimeCap: 25,
  perReferrerYearlyCapPaise: 1_000_000,
  weeklyVestCap: 5,
  expertYearlyReferralCap: 10,
  expertWaiverSessions: 3,
  expertWaiverDays: 90,
  expertReferralBudgetPaise: 180_000,
  version: 3,
  updatedAt: NOW,
  ...over,
});

const qualifying = (refunds: { status: string }[] = []) => ({
  id: "ref-1",
  status: "QUALIFYING",
  referredUserId: "buyer",
  qualifiedAt: new Date(NOW.getTime() - 10 * DAY),
  referralCodeId: "code-1",
  referralCode: { userId: "referrer", user: { consultantProfile: null } },
  referredUser: { consultantProfile: null },
  qualifyingPayment: {
    id: "pay-1",
    userId: "buyer",
    appointmentId: "appt-1",
    appointment: { appointmentType: "CONSULTATION" },
    refunds,
    disputes: [],
    earnings: [{ consultantProfile: { userId: "expert" } }],
  },
  qualifyingOccurrence: {
    id: "occ-1",
    completionStatus: "COMPLETED",
    endsAt: new Date(NOW.getTime() - 3 * DAY),
    deletedAt: null,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  tx.referralProgramConfig.findUnique.mockResolvedValue(config());
  tx.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 });
  tx.referralCredit.findFirst.mockResolvedValue({ id: "cr-1", amount: 30_000 });
  tx.referralCredit.aggregate.mockResolvedValue({ _sum: { amount: null } });
  tx.referralCredit.updateMany.mockResolvedValue({ count: 1 });
  tx.referral.count.mockResolvedValue(0);
  tx.referral.updateMany.mockResolvedValue({ count: 1 });
  tx.referralCode.updateMany.mockResolvedValue({ count: 1 });
  tx.payment.findFirst.mockResolvedValue(null);
  tx.platformFeeSchedule.findFirst.mockResolvedValue({
    id: "fs-1",
    marketplaceBps: 2000,
    ownLinkBps: 1000,
  });
});

describe("take rate", () => {
  const payment = {
    id: "pay-1",
    userId: "buyer",
    platformFeeBps: null,
    attributionSource: "OWN_LINK" as const,
  };

  it("charges the own-link rate and stamps the bps on the Payment", async () => {
    tx.consultantFeeWaiver.findFirst.mockResolvedValue(null);
    const fee = await settleB2cPlatformFeePaise(T, payment, "cp-1", 150_000, {
      allowWaiver: true,
    });
    expect(fee).toBe(15_000);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { platformFeeBps: 1000, attributionSource: "OWN_LINK" },
    });
  });

  it("spends a live waiver by CAS and charges 0", async () => {
    tx.consultantFeeWaiver.findFirst.mockResolvedValue({ id: "w-1" });
    tx.consultantFeeWaiver.updateMany.mockResolvedValue({ count: 1 });
    const fee = await settleB2cPlatformFeePaise(T, payment, "cp-1", 150_000, {
      allowWaiver: true,
    });
    expect(fee).toBe(0);
    expect(tx.consultantFeeWaiver.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "w-1",
        sessionsRemaining: { gt: 0 },
        expiresAt: { gt: expect.any(Date) },
      }),
      data: { sessionsRemaining: { decrement: 1 } },
    });
  });
});

describe("vest", () => {
  it("vests through a CAS that repeats the refund guard, then posts the liability", async () => {
    tx.referral.findUnique.mockResolvedValue(qualifying());
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("VESTED");
    const vestCall = tx.referral.updateMany.mock.calls.find(
      ([a]) => a.data.status === "VESTED",
    );
    expect(vestCall?.[0].where.qualifyingPayment.refunds).toEqual({
      none: { status: { in: ["PENDING", "SUCCEEDED"] } },
    });
    expect(mockPostLedgerTxn).toHaveBeenCalledWith(
      T,
      expect.objectContaining({
        idempotencyKey: "referral-vest:cr-1",
        postings: [
          {
            account: { kind: "PLATFORM_PROMO" },
            direction: "DEBIT",
            amountPaise: 30_000,
          },
          {
            account: { kind: "REFERRAL_CREDIT_LIABILITY" },
            direction: "CREDIT",
            amountPaise: 30_000,
          },
        ],
      }),
    );
  });

  it("defers with no posting when a refund lands before the CAS commits", async () => {
    tx.referral.findUnique.mockResolvedValue(qualifying());
    tx.referral.updateMany.mockResolvedValue({ count: 0 });
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("DEFERRED");
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });

  it("voids the referral and its PENDING credit on a refund", async () => {
    tx.referral.findUnique.mockResolvedValue(
      qualifying([{ status: "SUCCEEDED" }]),
    );
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("VOIDED");
    expect(tx.referral.updateMany).toHaveBeenCalledWith({
      where: { id: "ref-1", status: "QUALIFYING" },
      data: { status: "VOID", voidReason: "REFUNDED" },
    });
    expect(tx.referralCredit.updateMany).toHaveBeenCalledWith({
      where: { referralId: "ref-1", state: "PENDING" },
      data: { state: "VOID", voidedAt: NOW },
    });
  });

  it("blocks the vest when the month's budget would overrun", async () => {
    tx.referral.findUnique.mockResolvedValue(qualifying());
    tx.referralProgramConfig.findUnique.mockResolvedValue(
      config({ currentMonthSpentPaise: 80_000 }),
    );
    tx.referralProgramConfig.updateMany.mockResolvedValue({ count: 0 });
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe(
      "BUDGET_EXHAUSTED",
    );
    expect(tx.referralProgramConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentMonthSpentPaise: { lte: 70_000 },
        }),
      }),
    );
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });
});

describe("redemption cap", () => {
  it("caps credits at min(programme cap, take rate) of the list price", async () => {
    const derived = await deriveCheckoutAmount({
      basePaise: 150_000,
      buyerCountry: "IN",
      useReferralCredits: true,
      creditCapBps: 1000,
      resolveAvailableCreditsPaise: () => 30_000,
    });
    expect(derived.creditsApplied).toBe(15_000);
  });
});
