/**
 * A ₹0 purchase never qualifies a referral or owns a buyer relationship, even
 * when the programme's minimum order is zero: no cash, no reward.
 */
jest.mock("@/lib/referrals/program-config", () => ({
  readReferralProgramConfig: jest.fn(async () => ({
    version: 1,
    qualifyWindowDays: 30,
    minOrderPaise: 0,
    referrerRewardPaise: 10_000,
  })),
  recordBudgetSpend: jest.fn(async () => undefined),
}));

import type { Tx } from "@/lib/prisma";
import { recordReferralCapture } from "@/lib/referrals/capture";

function fakeTx(cardLegsPaise: number[]) {
  const tx = {
    payment: {
      findUnique: jest.fn(async () => ({
        id: "pay_1",
        userId: "buyer",
        paymentStatus: "SUCCEEDED",
        appointmentId: "appt_1",
        attributionSource: "CONSUMER_REFERRAL",
        attributionReferralId: "ref_1",
        welcomeDiscountPaise: 0,
        legs: cardLegsPaise.map((amountPaise) => ({ amountPaise })),
      })),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({ userId: "expert" })),
    },
    appointmentOccurrence: {
      findFirst: jest.fn(async () => ({ id: "occ_1" })),
    },
    referral: {
      findUnique: jest.fn(async () => ({
        id: "ref_1",
        referralCode: { userId: "referrer" },
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    referralCredit: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    expertCustomerRelationship: {
      createMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  return tx;
}

const asTx = (tx: ReturnType<typeof fakeTx>) => tx as unknown as Tx;

it("a ₹0 referred purchase credits no reward and owns no relationship", async () => {
  const tx = fakeTx([]);
  await recordReferralCapture(asTx(tx), {
    paymentId: "pay_1",
    consultantProfileId: "cp_1",
  });
  expect(tx.referral.updateMany).not.toHaveBeenCalled();
  expect(tx.referralCredit.createMany).not.toHaveBeenCalled();
  expect(tx.referralCredit.updateMany).not.toHaveBeenCalled();
  expect(tx.expertCustomerRelationship.createMany).not.toHaveBeenCalled();
});

it("a paid referred purchase still qualifies the referral", async () => {
  const tx = fakeTx([50_000]);
  await recordReferralCapture(asTx(tx), {
    paymentId: "pay_1",
    consultantProfileId: "cp_1",
  });
  expect(tx.referralCredit.createMany).toHaveBeenCalledTimes(1);
  expect(tx.expertCustomerRelationship.createMany).toHaveBeenCalledTimes(1);
});
