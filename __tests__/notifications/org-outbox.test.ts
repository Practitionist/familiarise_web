/**
 * @jest-environment node
 */

// Org helpers stage one durable row per recipient, using the caller's transaction.

const mockTrigger = jest.fn();
const mockUpsert = jest.fn();
const mockUpdate = jest.fn();
const mockFindMany = jest.fn();
const mockUserRead = jest.fn();

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
    triggerBroadcast: jest.fn(),
  }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        notificationOutbox: {
          upsert: (...args: unknown[]) => mockUpsert(...args),
        },
        user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
      }),
    notificationOutbox: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
    membership: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { notifyPayoutFailed } from "@/lib/novu/service";
import { notifyOrgWalletLow } from "@/lib/novu/org-workflows";

const roster = [{ userId: "user-b" }, { userId: "user-a" }];
const payload = {
  orgName: "Acme",
  balancePaise: 1000,
  minimumPaise: 5000,
  currency: "INR",
  topUpUrl: "/dashboard/wallet",
};

function stagedRow(args: { create: Record<string, unknown> }) {
  return {
    id: args.create.transactionId,
    createdAt: new Date(),
    workflowId: args.create.workflowId,
    kind: args.create.kind,
    recipients: args.create.recipients,
    payload: args.create.payload,
    transactionId: args.create.transactionId,
    attempts: 0,
    status: "PENDING",
  };
}

beforeEach(() => {
  mockFindMany.mockResolvedValue(roster);
  mockUserRead.mockResolvedValue([{ id: "user-b" }, { id: "user-a" }]);
  mockUpsert.mockImplementation(async (args) => stagedRow(args));
  mockUpdate.mockResolvedValue({});
  mockTrigger.mockResolvedValue({});
});
afterEach(() => jest.clearAllMocks());

describe("org helpers ride the outbox", () => {
  it("stages each roster recipient independently and attempts them inline", async () => {
    const staged = await notifyOrgWalletLow("org-1", payload);

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const { create } = mockUpsert.mock.calls[0][0];
    expect(create.kind).toBe("SINGLE");
    expect(create.workflowId).toBe(NOVU_WORKFLOWS.ORG_WALLET_LOW);
    expect(create.recipients).toEqual(["user-b"]);
    expect(mockTrigger).toHaveBeenCalledTimes(2);
    expect(mockTrigger.mock.calls.map(([input]) => input.to)).toEqual([
      "user-b",
      "user-a",
    ]);
    expect(staged).toEqual([]);
  });

  it("with { tx } reads the roster and stages through the tx, sends nothing, returns the row", async () => {
    const txUpsert = jest.fn(async (args) => stagedRow(args));
    const txFindMany = jest.fn().mockResolvedValue(roster);
    const tx = {
      notificationOutbox: { upsert: txUpsert },
      user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
      membership: { findMany: txFindMany },
    };

    const staged = await notifyOrgWalletLow("org-1", payload, {
      tx: tx as never,
      entityRef: "org:org-1",
    });

    expect(txFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(txUpsert).toHaveBeenCalledTimes(2);
    expect(txUpsert.mock.calls[0][0].create.entityRef).toBe("org:org-1");
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(staged).toHaveLength(2);
    expect(staged[0].workflowId).toBe(NOVU_WORKFLOWS.ORG_WALLET_LOW);
  });
});

it("keeps distinct failed payouts distinct even when amounts and reasons match", async () => {
  const details = {
    amount: 10000,
    currency: "INR",
    reason: "bank rejected",
    dashboardUrl: "/dashboard/earnings",
  };
  await notifyPayoutFailed(
    "user-a",
    { ...details, payoutId: "payout-one" },
    { deferAttempt: true },
  );
  await notifyPayoutFailed(
    "user-a",
    { ...details, payoutId: "payout-two" },
    { deferAttempt: true },
  );
  const first = mockUpsert.mock.calls[0][0].create;
  const second = mockUpsert.mock.calls[1][0].create;
  expect(first.transactionId).not.toBe(second.transactionId);
  expect(first.entityRef).toBe("payout:payout-one");
  expect(second.entityRef).toBe("payout:payout-two");
});

it("returns failure without sending when a nontransactional policy read fails", async () => {
  mockUserRead.mockRejectedValueOnce(new Error("pool unavailable"));
  const result = await notifyPayoutFailed("user-a", {
    amount: 10000,
    currency: "INR",
    payoutId: "payout-one",
    dashboardUrl: "/dashboard/earnings",
  });
  expect(result.success).toBe(false);
  expect(mockUpsert).not.toHaveBeenCalled();
  expect(mockTrigger).not.toHaveBeenCalled();
});
