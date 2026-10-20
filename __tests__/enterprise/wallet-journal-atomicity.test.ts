/**
 * @jest-environment node
 */

/**
 * The org wallet never moves without its journal: a stale top-up is settled
 * against the gateway before it is deleted, a checkout wallet debit commits
 * only with its Dr WALLET line, and an ops adjustment posts its balanced pair.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    walletTopUp: { findMany: jest.fn(), deleteMany: jest.fn() },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_j: string, _o: unknown, fn: () => unknown) => fn()),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  resolvePaymentForEarnings: jest.fn(),
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/referrals/capture", () => ({
  recordReferralCaptureInSavepoint: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  ...jest.requireActual("../../lib/api/organizations/wallet"),
  confirmTopUp: jest.fn(),
}));

import prisma, { type Tx } from "../../lib/prisma";
import { readRazorpayOrderHolding } from "../../lib/payments/core/razorpay";
import { postLedgerTxn } from "../../lib/payments/ledger/post";
import { resolvePaymentForEarnings } from "../../lib/payments/payouts";
import {
  adjustWallet,
  confirmTopUp,
  WalletDebitUnjournaledError,
  WalletInsufficientFundsError,
} from "../../lib/api/organizations/wallet";
import { recordSynchronousEarnings } from "../../lib/payments/checkout/commit/ledger";
import { cleanupAbandonedOrgTopUps } from "../../scripts/cleanup/cleanup-abandoned-org-top-ups";
import type { CheckoutCommitInput } from "../../lib/payments/checkout/commit/types";

const db = prisma as unknown as {
  walletTopUp: { findMany: jest.Mock; deleteMany: jest.Mock };
};
const holding = readRazorpayOrderHolding as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("org wallet journal atomicity", () => {
  it("confirms a captured stale top-up, deletes an empty one, and skips one the gateway cannot answer", async () => {
    const row = (id: string) => ({
      id,
      billingAccountId: "ba_1",
      providerOrderId: `we_${id}`,
      amountPaise: 50_000,
      notes: `razorpay_order=order_${id}`,
    });
    db.walletTopUp.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    holding
      .mockResolvedValueOnce({
        kind: "captured",
        paymentId: "pay_a",
        amountPaise: 50_000,
      })
      .mockResolvedValueOnce({ kind: "empty" })
      .mockRejectedValueOnce(new Error("gateway down"));
    (confirmTopUp as jest.Mock).mockResolvedValue({ confirmed: true });
    db.walletTopUp.deleteMany.mockResolvedValue({ count: 1 });

    const r = await cleanupAbandonedOrgTopUps();

    expect(db.walletTopUp.findMany.mock.calls[0][0].where.notes).toEqual({
      contains: "razorpay_order=order_",
    });
    expect(confirmTopUp).toHaveBeenCalledWith(expect.anything(), {
      providerOrderId: "we_a",
      providerPaymentId: "pay_a",
      amountPaise: 50_000,
    });
    expect(db.walletTopUp.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.walletTopUp.deleteMany.mock.calls[0][0].where.id).toBe("b");
    expect(r).toMatchObject({ confirmed: 1, reaped: 1, success: false });
  });

  it("refuses a wallet checkout whose earnings early-returned without the Dr WALLET line", async () => {
    (resolvePaymentForEarnings as jest.Mock).mockResolvedValue(null);
    const tx = {
      ledgerEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as Tx;
    const input = {
      validatedData: { appointmentType: "CONSULTATION" },
      isOrgWalletPayment: true,
    } as unknown as CheckoutCommitInput;

    await expect(
      recordSynchronousEarnings(tx, input, {
        payment: { id: "pmt_1", amount: 1000, expiresAt: null },
        skipPayment: true,
      }),
    ).rejects.toBeInstanceOf(WalletDebitUnjournaledError);
  });

  it("posts an adjustment as one balanced pair and never overdraws on a debit", async () => {
    (postLedgerTxn as jest.Mock).mockResolvedValue({
      transactionId: "t1",
      created: true,
    });
    const tx = {
      billingAccount: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ownerOrgId: "org_1", walletBalance: 0 }),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    } as unknown as Tx;

    await expect(
      adjustWallet(tx, {
        billingAccountId: "ba_1",
        amountPaise: -500,
        idempotencyKey: "k1",
        description: "fix",
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientFundsError);
    expect((postLedgerTxn as jest.Mock).mock.calls[0][1]).toMatchObject({
      idempotencyKey: "walletadj:k1",
      kind: "WALLET_ADJUSTMENT",
      postings: [
        {
          account: { kind: "WALLET", organizationId: "org_1" },
          direction: "DEBIT",
          amountPaise: 500,
        },
        {
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: 500,
        },
      ],
    });
  });
});
