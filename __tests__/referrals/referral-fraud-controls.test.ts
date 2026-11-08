/**
 * @jest-environment node
 */

/**
 * Referral fraud controls: alias and disposable refusals at apply, the shared-payer void and the
 * review hold at vest, the admin release and void, and the lost-chargeback void after vest.
 */

const mockPostLedgerTxn = jest.fn();
jest.mock("@/lib/referrals/referral-notify", () => ({
  stageReferralReward: jest.fn(async () => ({})),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const tx = {
  referral: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
  },
  referralCode: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  referralProgramConfig: { findUnique: jest.fn(), updateMany: jest.fn() },
  referralCredit: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  payment: { count: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
  consultantFeeWaiver: { updateMany: jest.fn() },
  referralCreditUsage: { findMany: jest.fn(), delete: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));

import prisma, { type Tx } from "@/lib/prisma";
import {
  isDisposableEmail,
  normaliseEmail,
} from "@/lib/referrals/email-signals";
import {
  applyReferralCode,
  reverseCreditsForPayment,
} from "@/lib/referrals/service";
import { settleQualifyingReferral } from "@/lib/referrals/vesting";
import { releaseHeldReferral, voidHeldReferral } from "@/lib/referrals/review";
import { voidVestedReferralRewards } from "@/lib/referrals/credit-reversal";
import { recordPayerInstruments } from "@/lib/payments/payer-instruments";
import { clampPage } from "@/components/dashboard/backoffice/referrals/HeldReferralsPanel";

const NOW = new Date("2026-11-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let T: Tx;
beforeAll(async () => {
  T = await prisma.$transaction(async (t) => t);
});

const config = (over: Record<string, unknown> = {}) => ({
  id: "singleton",
  isActive: true,
  paused: false,
  monthlyBudgetPaise: 100_000,
  currentPeriod: "2026-11",
  currentMonthSpentPaise: 0,
  referrerRewardPaise: 30_000,
  discountBps: 0,
  discountMaxPaise: 0,
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
  holdSameIpReferrals: null,
  holdSameDeviceReferrals: null,
  holdWindowDays: null,
  version: 3,
  updatedAt: NOW,
  ...over,
});

const qualifying = (over: Record<string, unknown> = {}) => ({
  id: "ref-1",
  status: "QUALIFYING",
  referredUserId: "buyer",
  qualifiedAt: new Date(NOW.getTime() - 10 * DAY),
  referralCodeId: "code-1",
  ipHash: "ip-a",
  userAgent: "UA",
  reviewReleasedAt: null,
  referralCode: { userId: "referrer", user: { consultantProfile: null } },
  referredUser: { name: "Friend", consultantProfile: null },
  qualifyingPayment: {
    id: "pay-1",
    userId: "buyer",
    appointmentId: "appt-1",
    payerVpaHash: "vpa-a",
    payerPhoneHash: null,
    appointment: { appointmentType: "CONSULTATION" },
    refunds: [],
    disputes: [],
    earnings: [{ consultantProfile: { userId: "expert" } }],
  },
  qualifyingOccurrence: {
    id: "occ-1",
    completionStatus: "COMPLETED",
    endsAt: new Date(NOW.getTime() - 3 * DAY),
    deletedAt: null,
  },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  tx.referralProgramConfig.findUnique.mockResolvedValue(config());
  tx.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 });
  tx.referral.updateMany.mockResolvedValue({ count: 1 });
  tx.referral.count.mockResolvedValue(0);
  tx.referralCode.updateMany.mockResolvedValue({ count: 1 });
  tx.referralCredit.findFirst.mockResolvedValue({ id: "cr-1", amount: 30_000 });
  tx.referralCredit.updateMany.mockResolvedValue({ count: 1 });
  tx.payment.findFirst.mockResolvedValue(null);
  tx.consultantFeeWaiver.updateMany.mockResolvedValue({ count: 0 });
});

describe("apply-time email checks", () => {
  it("normalises aliases and spots disposable domains", () => {
    expect(normaliseEmail("Priya.A+ref@GoogleMail.com")).toBe(
      "priyaa@gmail.com",
    );
    expect(normaliseEmail("p.a+x@example.in")).toBe("p.a@example.in");
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@inbox.yopmail.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
  });

  const arrangeApply = (refereeEmail: string, referrerEmail: string) => {
    tx.referralCode.findFirst.mockResolvedValue({
      id: "code-1",
      userId: "referrer",
      totalReferrals: 0,
      maxReferrals: 25,
    });
    tx.user.findUnique.mockImplementation(({ where }) =>
      where.id === "buyer"
        ? { createdAt: new Date(), email: refereeEmail }
        : { name: "Priya", email: referrerEmail },
    );
    tx.payment.count.mockResolvedValue(0);
    tx.referral.findUnique.mockResolvedValue(null);
    tx.referral.create.mockResolvedValue({ id: "ref-new" });
  };

  it.each([
    ["the referrer's own mailbox", "priya.a+2@gmail.com", "priyaa@gmail.com"],
    ["a disposable mailbox", "friend@yopmail.com", "priya@gmail.com"],
  ])("refuses %s like any other refusal", async (_c, referee, referrer) => {
    arrangeApply(referee, referrer);
    expect(await applyReferralCode("buyer", "PRIYA1")).toBeNull();
    expect(tx.referral.create).not.toHaveBeenCalled();
  });

  it("stores the request signals on an accepted referral", async () => {
    arrangeApply("charlotte@example.com", "priya@gmail.com");
    await applyReferralCode("buyer", "PRIYA1", {
      ipHash: "ip-a",
      userAgent: "UA",
    });
    expect(tx.referral.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ipHash: "ip-a", userAgent: "UA" }),
    });
  });
});

describe("vest-time controls", () => {
  it("voids SHARED_PAYER when the referrer paid with the same UPI address", async () => {
    tx.referral.findUnique.mockResolvedValue(qualifying());
    tx.payment.findFirst.mockResolvedValue({ id: "pay-referrer" });
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("VOIDED");
    expect(tx.payment.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "referrer",
        id: { not: "pay-1" },
        OR: [{ payerVpaHash: "vpa-a" }],
      },
      select: { id: true },
    });
    expect(tx.referral.updateMany).toHaveBeenCalledWith({
      where: { id: "ref-1", status: "QUALIFYING" },
      data: { status: "VOID", voidReason: "SHARED_PAYER" },
    });
  });

  it("holds a referral whose IP hash recurs, without touching the PENDING credit", async () => {
    tx.referral.findUnique.mockResolvedValue(qualifying());
    tx.referralProgramConfig.findUnique.mockResolvedValue(
      config({ holdSameIpReferrals: 3, holdWindowDays: 7 }),
    );
    tx.referral.count.mockResolvedValue(3);
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("HELD");
    expect(tx.referral.count).toHaveBeenCalledWith({
      where: {
        referralCodeId: "code-1",
        ipHash: "ip-a",
        signedUpAt: { gte: new Date(NOW.getTime() - 7 * DAY) },
      },
    });
    expect(tx.referral.updateMany).toHaveBeenCalledWith({
      where: { id: "ref-1", status: "QUALIFYING" },
      data: { status: "HELD", heldAt: NOW, heldReason: "SAME_IP" },
    });
    expect(tx.referralCredit.updateMany).not.toHaveBeenCalled();
  });

  it("vests a released referral instead of holding it again", async () => {
    tx.referral.findUnique.mockResolvedValue(
      qualifying({ reviewReleasedAt: NOW }),
    );
    tx.referralProgramConfig.findUnique.mockResolvedValue(
      config({ holdSameIpReferrals: 2 }),
    );
    tx.referral.count.mockResolvedValue(9);
    expect(await settleQualifyingReferral("ref-1", NOW)).toBe("VESTED");
    expect(tx.referral.count).not.toHaveBeenCalled();
  });

  it("release and void move only a HELD row; void takes the PENDING credit with it", async () => {
    expect(await releaseHeldReferral(T, "ref-1", NOW)).toBe("RELEASED");
    expect(tx.referral.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ref-1", status: "HELD" },
      data: { status: "QUALIFYING", reviewReleasedAt: NOW },
    });
    expect(await voidHeldReferral(T, "ref-1", NOW)).toBe("VOIDED");
    expect(tx.referralCredit.updateMany).toHaveBeenCalledWith({
      where: { referralId: "ref-1", state: "PENDING" },
      data: { state: "VOID", voidedAt: NOW },
    });
    tx.referral.updateMany.mockResolvedValue({ count: 0 });
    expect(await voidHeldReferral(T, "ref-1", NOW)).toBe("NOT_HELD");
  });
});

describe("lost chargeback after vest", () => {
  /** One vested credit whose CAS matches the row as stored. */
  const arrangeCredit = (usedAmount: number) => {
    const row = {
      id: "cr-1",
      amount: 30_000,
      usedAmount,
      remainingAmount: 30_000 - usedAmount,
      state: "VESTED",
      vestedAt: new Date(NOW.getTime() - 5 * DAY),
      reversedAt: null as Date | null,
    };
    tx.referral.findMany.mockResolvedValue([
      { id: "ref-1", referralCode: { userId: "referrer" } },
    ]);
    tx.referralCredit.findMany.mockImplementation(async ({ where }) =>
      row.reversedAt || where.referralId !== "ref-1" ? [] : [{ id: row.id }],
    );
    tx.referralCredit.findUnique.mockImplementation(async () => ({ ...row }));
    tx.referralCredit.updateMany.mockImplementation(async ({ where, data }) => {
      const match =
        row.reversedAt === where.reversedAt &&
        row.state === where.state &&
        row.remainingAmount === where.remainingAmount;
      if (match) Object.assign(row, data);
      return { count: match ? 1 : 0 };
    });
    return row;
  };
  const settle = () =>
    voidVestedReferralRewards(T, {
      paymentId: "pay-1",
      disputeId: "disp_1",
      now: NOW,
    });

  it.each([
    ["fully unspent", 0, 30_000],
    ["partly spent", 12_000, 18_000],
  ])(
    "%s: voids the remainder with a balanced reversal",
    async (_c, used, left) => {
      const row = arrangeCredit(used);
      expect(await settle()).toEqual({
        reversedPaise: left,
        waiversRevoked: 0,
      });
      expect(row).toMatchObject({
        state: "VOID",
        amount: used,
        usedAmount: used,
        remainingAmount: 0,
      });
      expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
      const [, txn] = mockPostLedgerTxn.mock.calls[0];
      expect(txn.idempotencyKey).toBe("referral-reverse:cr-1");
      expect(txn.postings).toEqual([
        {
          account: { kind: "REFERRAL_CREDIT_LIABILITY" },
          direction: "DEBIT",
          amountPaise: left,
        },
        {
          account: { kind: "PLATFORM_PROMO" },
          direction: "CREDIT",
          amountPaise: left,
        },
      ]);
    },
  );

  it("retires a fully reserved credit, so the failed checkout's restore stays dead", async () => {
    const row = arrangeCredit(30_000);
    expect(await settle()).toEqual({ reversedPaise: 0, waiversRevoked: 0 });
    expect(row).toMatchObject({ state: "VOID", reversedAt: NOW });
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();

    tx.referralCreditUsage.findMany.mockResolvedValue([
      {
        id: "use-1",
        creditId: "cr-1",
        amount: 30_000,
        originalAmount: 30_000,
        restoredAmount: 0,
        credit: { ...row, expiresAt: null },
      },
    ]);
    tx.referralCredit.updateMany.mockImplementation(async ({ where, data }) => {
      const match = row.reversedAt !== null && row.state === where.state;
      if (match) {
        row.usedAmount -= data.usedAmount.decrement;
        row.remainingAmount += data.remainingAmount.increment;
      }
      return { count: match ? 1 : 0 };
    });
    expect(await reverseCreditsForPayment("pay-unpaid", T)).toBe(30_000);
    expect(row).toMatchObject({ state: "VOID", remainingAmount: 30_000 });
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });

  it("a replayed verdict is a no-op", async () => {
    arrangeCredit(0);
    await settle();
    mockPostLedgerTxn.mockClear();
    expect(await settle()).toEqual({ reversedPaise: 0, waiversRevoked: 0 });
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });

  it("leaves a payment that vested no referral untouched", async () => {
    tx.referral.findMany.mockResolvedValue([]);
    expect(await settle()).toEqual({ reversedPaise: 0, waiversRevoked: 0 });
    expect(tx.referralCredit.findMany).not.toHaveBeenCalled();
    expect(tx.consultantFeeWaiver.updateMany).not.toHaveBeenCalled();
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });

  it("settles a learner and an expert referral that share the payment", async () => {
    const row = arrangeCredit(0);
    tx.referral.findMany.mockResolvedValue([
      { id: "ref-1", referralCode: { userId: "referrer" } },
      { id: "ref-x", referralCode: { userId: "expert-a" } },
    ]);
    tx.consultantFeeWaiver.updateMany.mockResolvedValue({ count: 2 });
    expect(await settle()).toEqual({
      reversedPaise: 30_000,
      waiversRevoked: 2,
    });
    expect(row.state).toBe("VOID");
    expect(tx.consultantFeeWaiver.updateMany).toHaveBeenCalledWith({
      where: {
        referralId: { in: ["ref-1", "ref-x"] },
        sessionsRemaining: { gt: 0 },
      },
      data: { sessionsRemaining: 0 },
    });
  });
});

describe("payer instruments at capture", () => {
  it("fills each hash independently and never overwrites a recorded one", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-16";
    const row: Record<string, string | null> = {
      payerVpaHash: null,
      payerPhoneHash: null,
    };
    tx.payment.updateMany.mockImplementation(async ({ where, data }) => {
      const free = Object.keys(data).every((k) => where[k] === null && !row[k]);
      if (free) Object.assign(row, data);
      return { count: free ? 1 : 0 };
    });
    await recordPayerInstruments(T, "pay_1", { contact: "+91 98765 43210" });
    const phone = row.payerPhoneHash;
    expect(phone).toEqual(expect.any(String));
    await recordPayerInstruments(T, "pay_1", {
      contact: "+91 90000 00000",
      upi: { vpa: "friend@okaxis" },
    });
    expect(row.payerVpaHash).toEqual(expect.any(String));
    expect(row.payerPhoneHash).toBe(phone);
  });
});

describe("held queue paging", () => {
  it("steps back when deciding the last row empties the last page", () => {
    expect(clampPage(3, 2)).toBe(2);
    expect(clampPage(2, 0)).toBe(1);
    expect(clampPage(1, 4)).toBe(1);
  });
});
