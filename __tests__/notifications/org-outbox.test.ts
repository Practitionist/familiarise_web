/**
 * @jest-environment node
 */

/**
 * #691 — the ORG_* family rides the outbox. Pins: an org helper stages one
 * MULTI row for the roster and attempts it inline; with `{ tx }` the roster
 * and the row both go through the transaction, nothing is sent, and the
 * staged row comes back for the post-commit attempt.
 */

const mockTrigger = jest.fn();
const mockUpsert = jest.fn();
const mockUpdate = jest.fn();
const mockFindMany = jest.fn();

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
    notificationOutbox: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
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
    id: "row-1",
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
  mockUpsert.mockImplementation(async (args) => stagedRow(args));
  mockUpdate.mockResolvedValue({});
  mockTrigger.mockResolvedValue({});
});
afterEach(() => jest.clearAllMocks());

describe("org helpers ride the outbox (#691)", () => {
  it("stages one MULTI row for the roster and attempts it inline", async () => {
    const staged = await notifyOrgWalletLow("org-1", payload);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const { create } = mockUpsert.mock.calls[0][0];
    expect(create.kind).toBe("MULTI");
    expect(create.workflowId).toBe(NOVU_WORKFLOWS.ORG_WALLET_LOW);
    expect(create.recipients).toEqual(["user-b", "user-a"]);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger.mock.calls[0][0].to).toEqual(["user-b", "user-a"]);
    expect(staged).toEqual([]);
  });

  it("with { tx } reads the roster and stages through the tx, sends nothing, returns the row", async () => {
    const txUpsert = jest.fn(async (args) => stagedRow(args));
    const txFindMany = jest.fn().mockResolvedValue(roster);
    const tx = {
      notificationOutbox: { upsert: txUpsert },
      membership: { findMany: txFindMany },
    };

    const staged = await notifyOrgWalletLow("org-1", payload, {
      tx: tx as never,
      entityRef: "org:org-1",
    });

    expect(txFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(txUpsert).toHaveBeenCalledTimes(1);
    expect(txUpsert.mock.calls[0][0].create.entityRef).toBe("org:org-1");
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(staged).toHaveLength(1);
    expect(staged[0].workflowId).toBe(NOVU_WORKFLOWS.ORG_WALLET_LOW);
  });
});
