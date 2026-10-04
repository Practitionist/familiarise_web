/**
 * @jest-environment node
 */

/**
 * Referral service pins: a refund never restores credit onto an expired credit, and a
 * payment's credits ride one aggregated REFERRAL_CREDIT leg.
 */

import { QUALIFICATION_WINDOW_DAYS } from "@/lib/referrals/constants";

const mockTx = {
  referral: { findMany: jest.fn() },
  referralCode: { findUnique: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(mockTx),
    referralCode: {
      findUnique: (...args: unknown[]) =>
        mockTx.referralCode.findUnique(...args),
    },
    referral: {
      findMany: (...args: unknown[]) => mockTx.referral.findMany(...args),
    },
  },
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

import {
  applyCreditsToPayment,
  getUserReferrals,
  reverseCreditsForPayment,
} from "@/lib/referrals/service";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("REF-2 — reverseCreditsForPayment skips expired credits", () => {
  it("restores live credits and leaves expired ones untouched", async () => {
    const past = new Date(Date.now() - DAY_MS); // already expired
    const future = new Date(Date.now() + 30 * DAY_MS); // still valid

    const tx = {
      referralCreditUsage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "use-expired",
            creditId: "credit-expired",
            amount: 500,
            originalAmount: 500,
            restoredAmount: 0,
            credit: { expiresAt: past },
          },
          {
            id: "use-live",
            creditId: "credit-live",
            amount: 300,
            originalAmount: 300,
            restoredAmount: 0,
            credit: { expiresAt: future },
          },
        ]),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      referralCredit: { update: jest.fn().mockResolvedValue({}) },
    };

    // Full refund (no refundAmount) → restore everything still live.
    const restored = await reverseCreditsForPayment("pay-1", tx as never);

    expect(restored).toBe(300); // only the live credit
    expect(tx.referralCredit.update).toHaveBeenCalledTimes(1);
    expect(tx.referralCredit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "credit-live" } }),
    );
    // The expired credit must never be incremented back to life.
    expect(tx.referralCredit.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "credit-expired" } }),
    );
    expect(tx.referralCreditUsage.delete).toHaveBeenCalledWith({
      where: { id: "use-live" },
    });
  });

  it("treats null expiresAt as never-expiring (restores it)", async () => {
    const tx = {
      referralCreditUsage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "use-1",
            creditId: "credit-1",
            amount: 200,
            originalAmount: 200,
            restoredAmount: 0,
            credit: { expiresAt: null },
          },
        ]),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      referralCredit: { update: jest.fn().mockResolvedValue({}) },
    };

    const restored = await reverseCreditsForPayment("pay-2", tx as never);
    expect(restored).toBe(200);
    expect(tx.referralCredit.update).toHaveBeenCalledTimes(1);
  });
});

describe("applyCreditsToPayment — one REFERRAL_CREDIT leg per payment", () => {
  it("spends two credit rows through two usages and a single aggregated leg", async () => {
    const tx = {
      referralCredit: {
        findMany: jest.fn().mockResolvedValue([
          { id: "c1", remainingAmount: 3000 },
          { id: "c2", remainingAmount: 5000 },
        ]),
        update: jest.fn(),
      },
      referralCreditUsage: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: "use-1" })
          .mockResolvedValueOnce({ id: "use-2" }),
      },
      paymentLeg: { create: jest.fn() },
    };

    const res = await applyCreditsToPayment("u1", 6000, tx as never, "pay-1");

    expect(res).toEqual({ creditsUsed: 6000, remainingToPay: 0 });
    expect(tx.referralCreditUsage.create).toHaveBeenCalledTimes(2);
    expect(tx.paymentLeg.create).toHaveBeenCalledTimes(1);
    expect(tx.paymentLeg.create).toHaveBeenCalledWith({
      data: {
        paymentId: "pay-1",
        source: "REFERRAL_CREDIT",
        amountPaise: 6000,
        sourceRef: "use-1",
      },
    });
  });
});

describe("getUserReferrals — derives EXPIRED status at read time", () => {
  it("projects EXPIRED for stale SIGNED_UP referrals while keeping fresh or REWARDED rows intact", async () => {
    mockTx.referralCode.findUnique.mockResolvedValue({ id: "code-1" });
    const now = Date.now();
    mockTx.referral.findMany.mockResolvedValue([
      {
        id: "ref-stale-window",
        status: "SIGNED_UP",
        signedUpAt: new Date(now - (QUALIFICATION_WINDOW_DAYS + 2) * DAY_MS),
        referredUser: { name: "Stale SignedUp", image: null },
      },
      {
        id: "ref-fresh",
        status: "SIGNED_UP",
        signedUpAt: new Date(now - 2 * DAY_MS),
        referredUser: { name: "Fresh SignedUp", image: null },
      },
      {
        id: "ref-rewarded",
        status: "REWARDED",
        signedUpAt: new Date(now - 60 * DAY_MS),
        referredUser: { name: "Rewarded", image: null },
      },
    ]);

    const result = await getUserReferrals("user-1");

    expect(result.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: "ref-stale-window", status: "EXPIRED" },
      { id: "ref-fresh", status: "SIGNED_UP" },
      { id: "ref-rewarded", status: "REWARDED" },
    ]);
  });
});
