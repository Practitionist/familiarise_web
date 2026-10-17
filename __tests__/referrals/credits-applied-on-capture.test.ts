/**
 * @jest-environment node
 *
 * A card payment that spent referral credits bells "credits applied" when its
 * capture commits. Checkout bells only the payments that never see a
 * capture webhook; the webhook calls notifyCreditsAppliedForPaymentBestEffort
 * with the payment, which reads what checkout took from ReferralCreditUsage.
 */

const mockUsageFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    referralCreditUsage: {
      findMany: (...args: unknown[]) => mockUsageFindMany(...args),
    },
  },
}));
const mockNotifyCreditsApplied = jest.fn();
jest.mock("../../lib/novu/service", () => ({
  notifyReferralCreditsApplied: (...args: unknown[]) =>
    mockNotifyCreditsApplied(...args),
}));
const mockStageEmail = jest.fn();
jest.mock("../../lib/email/senders/money", () => ({
  stageReferralBonusEmail: (...args: unknown[]) => mockStageEmail(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/referrals/service", () => ({
  getUserCredits: jest.fn().mockResolvedValue({ totalAvailable: 2500 }),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "http://localhost" }));

import { notifyCreditsAppliedForPaymentBestEffort } from "@/lib/referrals/referral-notify";

const args = {
  paymentId: "pay_1",
  userId: "user_1",
  appointmentType: "CONSULTATION",
};

beforeEach(() => {
  mockUsageFindMany.mockReset();
  mockNotifyCreditsApplied.mockReset();
  mockNotifyCreditsApplied.mockResolvedValue({ staged: null });
  mockStageEmail.mockReset();
  mockStageEmail.mockResolvedValue([]);
});

describe("notifyCreditsAppliedForPaymentBestEffort", () => {
  it("bells the credits checkout took for the payment, summed across credits", async () => {
    mockUsageFindMany.mockResolvedValue([
      { originalAmount: BigInt(3000) },
      { originalAmount: BigInt(1500) },
    ]);

    await notifyCreditsAppliedForPaymentBestEffort(args);

    expect(mockUsageFindMany).toHaveBeenCalledWith({
      where: { paymentId: "pay_1" },
      select: { originalAmount: true },
    });
    expect(mockNotifyCreditsApplied).toHaveBeenCalledTimes(1);
    const [userId, payload] = mockNotifyCreditsApplied.mock.calls[0];
    expect(userId).toBe("user_1");
    expect(payload).toMatchObject({
      creditsUsed: 4500,
      remainingCredits: 2500,
      appointmentType: "CONSULTATION",
    });
    expect(mockStageEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user_1",
        kind: "CREDITS_APPLIED",
        amountPaise: 4500,
      }),
    );
  });

  it("states what was applied, not what is left after a partial restore", async () => {
    // `amount` is decremented by a partial refund; `originalAmount` never is.
    mockUsageFindMany.mockResolvedValue([{ originalAmount: BigInt(3000) }]);

    await notifyCreditsAppliedForPaymentBestEffort(args);

    expect(mockNotifyCreditsApplied.mock.calls[0][1].creditsUsed).toBe(3000);
  });

  it("does nothing for a payment that spent no credits", async () => {
    mockUsageFindMany.mockResolvedValue([]);

    await notifyCreditsAppliedForPaymentBestEffort(args);

    expect(mockNotifyCreditsApplied).not.toHaveBeenCalled();
    expect(mockStageEmail).not.toHaveBeenCalled();
  });

  it("never throws when the credit read fails", async () => {
    mockUsageFindMany.mockRejectedValue(new Error("db down"));
    const log = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      notifyCreditsAppliedForPaymentBestEffort(args),
    ).resolves.toBeUndefined();
    expect(mockNotifyCreditsApplied).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
