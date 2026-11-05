/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/senders/money", () => ({
  stageReferralBonusEmail: jest.fn(async () => []),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "https://example.test" }));
import prisma from "@/lib/prisma";
import {
  stageCreditsApplied,
  stageReferralReward,
} from "@/lib/referrals/referral-notify";
import { stageBell } from "@/lib/novu/stage-bell";
import { stageReferralBonusEmail } from "@/lib/email/senders/money";

const args = {
  paymentId: "pay1",
  userId: "u1",
  creditsUsedPaise: 4500,
  remainingPaise: 2500,
  appointmentType: "CONSULTATION",
};
beforeEach(() => jest.clearAllMocks());

it("stages both channels using the supplied transaction and immutable payment identity", async () => {
  await stageCreditsApplied(prisma, args);
  expect(stageBell).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({
      recipients: ["u1"],
      payload: expect.objectContaining({
        creditsUsed: 4500,
        remainingCredits: 2500,
      }),
      dedupeKey: "payment:pay1:referral-credits-applied",
      entityRef: "payment:pay1",
    }),
  );
  expect(stageReferralBonusEmail).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({
      paymentId: "pay1",
      kind: "CREDITS_APPLIED",
      amountPaise: 4500,
    }),
  );
  await stageCreditsApplied(prisma, { ...args, paymentId: "pay2" });
  expect(stageReferralBonusEmail).toHaveBeenLastCalledWith(
    prisma,
    expect.objectContaining({ paymentId: "pay2" }),
  );
});

it("does nothing when no credits were spent", async () => {
  expect(
    await stageCreditsApplied(prisma, { ...args, creditsUsedPaise: 0 }),
  ).toEqual({});
  expect(stageReferralBonusEmail).not.toHaveBeenCalled();
  expect(stageBell).not.toHaveBeenCalled();
});

it("propagates staging failures so the caller can roll back the source transaction", async () => {
  jest
    .mocked(stageReferralBonusEmail)
    .mockRejectedValueOnce(new Error("outbox unavailable"));
  await expect(stageCreditsApplied(prisma, args)).rejects.toThrow(
    "outbox unavailable",
  );
});

it.each(["BONUS_EARNED", "WELCOME_BONUS"] as const)(
  "stages %s with referral identity before commit",
  async (kind) => {
    await stageReferralReward(prisma, {
      kind,
      userId: "u1",
      referralId: "ref1",
      amountPaise: 3000,
      counterpartyName: "Alex",
    });
    expect(stageBell).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        recipients: ["u1"],
        dedupeKey: `referral:ref1:${kind}`,
        payload: expect.objectContaining({ bonusAmountPaise: 3000 }),
      }),
    );
    expect(stageReferralBonusEmail).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ referralId: "ref1", kind }),
    );
  },
);
