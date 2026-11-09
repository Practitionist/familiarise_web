/**
 * @jest-environment node
 */

/**
 * Referral credit breakage: a VESTED credit past its expiry moves to EXPIRED by
 * a CAS on its prior state and balances, and its unspent balance is posted from
 * the liability back to PLATFORM_PROMO.
 */

const mockPostLedgerTxn = jest.fn();
jest.mock("@/lib/referrals/referral-notify", () => ({
  stageReferralReward: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const tx = {
  referralCredit: { findUnique: jest.fn(), updateMany: jest.fn() },
};
const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    referralCredit: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    $transaction: (fn: (t: unknown) => unknown) => fn(tx),
  },
}));

import { expireReferralCredits } from "@/lib/referrals/vesting";

const NOW = new Date("2026-11-09T00:00:00Z");
const credit = {
  state: "VESTED",
  expiresAt: new Date("2026-11-01T00:00:00Z"),
  remainingAmount: 3_500,
  usedAmount: 1_500,
  vestedAt: new Date("2026-05-01T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValueOnce([{ id: "rc_1" }]).mockResolvedValue([]);
  tx.referralCredit.updateMany.mockResolvedValue({ count: 1 });
});

it("expires by CAS on the prior state and posts the remaining balance as breakage", async () => {
  tx.referralCredit.findUnique.mockResolvedValue(credit);

  const result = await expireReferralCredits({ limit: 10, now: NOW });

  expect(tx.referralCredit.updateMany).toHaveBeenCalledWith({
    where: {
      id: "rc_1",
      state: "VESTED",
      remainingAmount: 3_500,
      usedAmount: 1_500,
    },
    data: { state: "EXPIRED" },
  });
  expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
  const [client, txn] = mockPostLedgerTxn.mock.calls[0];
  expect(client).toBe(tx);
  expect(txn).toMatchObject({
    idempotencyKey: "referral-breakage:rc_1",
    postings: [
      {
        account: { kind: "REFERRAL_CREDIT_LIABILITY" },
        direction: "DEBIT",
        amountPaise: 3_500,
      },
      {
        account: { kind: "PLATFORM_PROMO" },
        direction: "CREDIT",
        amountPaise: 3_500,
      },
    ],
  });
  expect(result).toMatchObject({ expired: 1, breakagePaise: 3_500 });
});

it("a lost CAS posts nothing and counts nothing", async () => {
  tx.referralCredit.findUnique.mockResolvedValue(credit);
  tx.referralCredit.updateMany.mockResolvedValue({ count: 0 });

  const result = await expireReferralCredits({ limit: 10, now: NOW });

  expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  expect(result).toMatchObject({ expired: 0, breakagePaise: 0 });
});

it("a fully spent credit expires without a breakage posting", async () => {
  tx.referralCredit.findUnique.mockResolvedValue({
    ...credit,
    remainingAmount: 0,
    usedAmount: 5_000,
  });

  const result = await expireReferralCredits({ limit: 10, now: NOW });

  expect(tx.referralCredit.updateMany).toHaveBeenCalledTimes(1);
  expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  expect(result).toMatchObject({ expired: 1, breakagePaise: 0 });
});

it("a credit not yet past its expiry is left untouched", async () => {
  tx.referralCredit.findUnique.mockResolvedValue({
    ...credit,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  });

  await expireReferralCredits({ limit: 10, now: NOW });

  expect(tx.referralCredit.updateMany).not.toHaveBeenCalled();
  expect(mockPostLedgerTxn).not.toHaveBeenCalled();
});
