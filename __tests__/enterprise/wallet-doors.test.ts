/**
 * @jest-environment node
 */

/**
 * The org wallet doors: a drifted wallet is refused before any money moves, a
 * refund above ₹25,000 waits for a second admin, a refund already at the
 * gateway under its dedupe key is booked rather than repeated, and an
 * adjustment's refusals answer 409.
 */
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  }),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    billingAccount: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    walletTopUp: { findMany: jest.fn() },
    ledgerEntry: { findFirst: jest.fn(), groupBy: jest.fn(async () => []) },
    user: { count: jest.fn() },
    opsActionLog: { create: jest.fn(async () => ({ id: "log" })) },
    opsActionProposal: { updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => unknown): unknown => fn(db)),
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/payments/wallet-freeze", () => ({
  isWalletFrozen: jest.fn(),
  freezeWalletSpend: jest.fn(),
  unfreezeWalletSpend: jest.fn(),
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => ({
  walletDriftFindings: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  listRazorpayRefunds: jest.fn(),
  createRazorpayRefund: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST as unfreeze } from "../../app/api/admin/billing-accounts/[billingAccountId]/unfreeze/route";
import { POST as refundRemaining } from "../../app/api/admin/billing-accounts/[billingAccountId]/refund-remaining/route";
import { POST as adjust } from "../../app/api/admin/billing-accounts/[billingAccountId]/wallet-adjustment/route";
import {
  freezeWalletSpend,
  isWalletFrozen,
  unfreezeWalletSpend,
} from "../../lib/payments/wallet-freeze";
import { walletDriftFindings } from "../../scripts/reconcile/reconcile-ledgers";
import {
  createRazorpayRefund,
  listRazorpayRefunds,
} from "../../lib/payments/core/razorpay";
import { postLedgerTxn } from "../../lib/payments/ledger/post";

type MockDb = {
  billingAccount: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  walletTopUp: { findMany: jest.Mock };
  ledgerEntry: { findFirst: jest.Mock; groupBy: jest.Mock };
  user: { count: jest.Mock };
  opsActionProposal: { create: jest.Mock };
};
const db = jest.requireMock<{ default: MockDb }>("../../lib/prisma").default;

const call = async (door: typeof unfreeze, body: object = {}) => {
  const res = await door(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify({ reason: "org offboarding", ...body }),
    }),
    { params: Promise.resolve({ billingAccountId: "ba_1" }) },
  );
  return { status: res.status, json: await res.json() };
};

const drift = {
  findings: [
    {
      kind: "WALLET_BALANCE_DRIFT" as const,
      billingAccountId: "ba_1",
      expectedPaise: 5_000,
      actualPaise: 4_000,
      deltaPaise: -1_000,
    },
  ],
  accountsChecked: 1,
  inSync: [],
};
const clean = {
  findings: [],
  accountsChecked: 1,
  inSync: [
    { billingAccountId: "ba_1", organizationId: "org_1", driftFreezeId: null },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.billingAccount.findUnique.mockResolvedValue({
    id: "ba_1",
    ownerOrgId: "org_1",
    walletBalance: 4_000,
  });
  db.user.count.mockResolvedValue(2);
  jest.mocked(isWalletFrozen).mockResolvedValue(false);
  jest.mocked(walletDriftFindings).mockResolvedValue(clean);
});

describe("unfreeze", () => {
  it("keeps a still-drifted wallet frozen with 409 WALLET_STILL_DRIFTED", async () => {
    jest.mocked(isWalletFrozen).mockResolvedValue(true);
    jest.mocked(walletDriftFindings).mockResolvedValue(drift);

    const res = await call(unfreeze);

    expect(res).toMatchObject({
      status: 409,
      json: { code: "WALLET_STILL_DRIFTED" },
    });
    expect(unfreezeWalletSpend).not.toHaveBeenCalled();
  });
});

describe("refund-remaining", () => {
  it("refuses a drifted wallet with 409 WALLET_DRIFTED before freezing or refunding", async () => {
    jest.mocked(walletDriftFindings).mockResolvedValue(drift);

    const res = await call(refundRemaining);

    expect(res).toMatchObject({
      status: 409,
      json: { code: "WALLET_DRIFTED" },
    });
    expect(freezeWalletSpend).not.toHaveBeenCalled();
    expect(listRazorpayRefunds).not.toHaveBeenCalled();
  });

  it("holds a balance above ₹25,000 for a second admin with 202", async () => {
    db.billingAccount.findUnique.mockResolvedValue({
      walletBalance: 2_500_001,
    });
    db.opsActionProposal.create.mockResolvedValue({
      id: "prop_1",
      expiresAt: new Date(),
    });

    const res = await call(refundRemaining);

    expect(res).toMatchObject({
      status: 202,
      json: { status: "PROPOSED", proposalId: "prop_1" },
    });
    expect(db.opsActionProposal.create.mock.calls[0][0].data).toMatchObject({
      action: "wallet.refund_remaining",
      targetId: "ba_1",
      amountPaise: BigInt(2_500_001),
    });
    expect(freezeWalletSpend).not.toHaveBeenCalled();
  });

  it("books a refund found by its dedupe key instead of repeating it, the spent part as a receivable", async () => {
    db.walletTopUp.findMany.mockResolvedValue([
      {
        id: "t1",
        billingAccountId: "ba_1",
        amountPaise: 10_000,
        providerOrderId: "order_t1",
        providerPaymentId: "pay_t1",
      },
    ]);
    jest.mocked(listRazorpayRefunds).mockResolvedValue([
      {
        refundId: "rfnd_1",
        amount: 10_000,
        currency: "INR",
        status: "SUCCEEDED",
        metadata: { walletRefundKey: "wallet-refund:ba_1:t1" },
      },
    ]);
    db.billingAccount.findUniqueOrThrow
      .mockResolvedValueOnce({ walletBalance: 4_000 })
      .mockResolvedValueOnce({ walletBalance: 4_000, ownerOrgId: "org_1" })
      .mockResolvedValueOnce({ walletBalance: 0 });
    db.billingAccount.updateMany.mockResolvedValue({ count: 1 });
    jest
      .mocked(postLedgerTxn)
      .mockResolvedValue({ transactionId: "txn", created: true });
    jest.mocked(unfreezeWalletSpend).mockResolvedValue(true);

    const res = await call(refundRemaining);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      balanceAfterPaise: 0,
      frozen: false,
      refunds: [{ topUpId: "t1", refundId: "rfnd_1", reused: true }],
    });
    expect(createRazorpayRefund).not.toHaveBeenCalled();
    expect(db.billingAccount.updateMany.mock.calls[0][0].data).toEqual({
      walletBalance: { decrement: 4_000 },
    });
    expect(jest.mocked(postLedgerTxn).mock.calls[1][1]).toMatchObject({
      idempotencyKey: "topup-refund-shortfall:rfnd_1",
      postings: [
        {
          account: { kind: "ORG_RECEIVABLE", organizationId: "org_1" },
          direction: "DEBIT",
          amountPaise: 6_000,
        },
        {
          account: { kind: "WALLET", organizationId: "org_1" },
          direction: "CREDIT",
          amountPaise: 6_000,
        },
      ],
    });
  });
});

describe("wallet-adjustment", () => {
  const body = (amountPaise: number) => ({
    amountPaise,
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
  });

  beforeEach(() => {
    db.billingAccount.findUniqueOrThrow.mockResolvedValue({
      ownerOrgId: "org_1",
      walletBalance: 100,
    });
  });

  it("answers 409 IDEMPOTENCY_KEY_REUSED for a key already used for another amount", async () => {
    jest
      .mocked(postLedgerTxn)
      .mockResolvedValue({ transactionId: "txn", created: false });
    db.ledgerEntry.findFirst.mockResolvedValue({
      direction: "CREDIT",
      amountPaise: 700,
    });

    const res = await call(adjust, body(-500));

    expect(res).toMatchObject({
      status: 409,
      json: { code: "IDEMPOTENCY_KEY_REUSED" },
    });
  });

  it("answers 409 WALLET_INSUFFICIENT_FUNDS for a debit the wallet cannot cover", async () => {
    jest
      .mocked(postLedgerTxn)
      .mockResolvedValue({ transactionId: "txn", created: true });
    db.billingAccount.updateMany.mockResolvedValue({ count: 0 });

    const res = await call(adjust, body(-500));

    expect(res).toMatchObject({
      status: 409,
      json: { code: "WALLET_INSUFFICIENT_FUNDS" },
    });
  });
});
