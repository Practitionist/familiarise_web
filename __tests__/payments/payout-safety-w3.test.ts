/**
 * @jest-environment node
 *
 * Payout safety pins: one consultant's mint failure leaves the batch running,
 * a gateway completion of a locally FAILED payout re-attaches or claws back,
 * a reversed payout voids the clawbacks raised on it, a changed default
 * account cools off, and live RazorpayX calls leave only through the proxy.
 */

type Row = Record<string, unknown>;

const runTx = jest.fn();
const db = {
  consultantEarnings: {
    groupBy: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
  },
  consultantPayout: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
    update: jest.fn(async () => ({})),
  },
  payoutAccount: { findFirst: jest.fn() },
  ledgerTransaction: { findMany: jest.fn(async () => [] as Row[]) },
  $transaction: runTx,
};
runTx.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
  isMockRedis: () => false,
  checkRedisHealth: async () => true,
}));
const postLedgerTxn = jest.fn(async (_db: unknown, _input: Row) => ({
  transactionId: "t",
  created: true,
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (db: unknown, input: Row) => postLedgerTxn(db, input),
  ledgerAccountId: jest.fn(),
  ledgerBalancePaise: jest.fn(async () => 0),
}));
const postConsultantPayoutClawback = jest.fn(
  async (_tx: unknown, _i: Row) => {},
);
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  postConsultantPayoutClawback: (tx: unknown, i: Row) =>
    postConsultantPayoutClawback(tx, i),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
}));
const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutFailed: jest.fn(),
  notifyPayoutProcessed: jest.fn(),
}));
const proxyAgents: string[] = [];
const undiciFetch = jest.fn(async (_url: string, _init: Row) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ id: "pout_1", status: "processed" }),
}));
jest.mock(
  "undici",
  () => ({
    ProxyAgent: class {
      constructor(url: string) {
        proxyAgents.push(url);
      }
    },
    fetch: (url: string, init: Row) => undiciFetch(url, init),
  }),
  { virtual: true },
);

import {
  createPayoutBatch,
  handlePayoutWebhook,
} from "../../lib/payments/payouts/payout-service";
import { voidClawbacksRaisedOnPayout } from "../../lib/payments/payouts/clawback-recovery";
import { payoutEligibilityReason } from "../../lib/payments/payouts/payout-requirements";
import { RazorpayPayoutsService } from "../../lib/payments/payouts/razorpay-payouts";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

it("FIN-18: a consultant whose mint throws is reported once and the batch moves on", async () => {
  db.consultantEarnings.groupBy.mockResolvedValue([
    { consultantProfileId: "cp_a" },
    { consultantProfileId: "cp_b" },
  ]);
  db.payoutAccount.findFirst
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(null);

  const run = await createPayoutBatch();

  expect(db.payoutAccount.findFirst).toHaveBeenCalledTimes(2);
  expect(run).toMatchObject({ minted: 0, failed: 1 });
  expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  expect(reportSentryMessage.mock.calls[0][0]).toBe(
    "payout-batch-mint-failures",
  );
});

describe("FIN-17: payout.processed after the payout was failed locally", () => {
  const failed = {
    id: "po_1",
    consultantProfileId: "cp_1",
    amount: 100_000,
    currency: "INR",
    method: "BANK_TRANSFER",
    status: "FAILED",
    tdsDeducted: 0,
    tdsCreditPaise: 0,
    tdsRateAppliedBps: null,
    earnings: [],
  };
  const earning = (id: string, share: number) => ({
    id,
    consultantSharePaise: share,
    refundedShareAmount: 0,
  });

  function arrange(stillAttached: Row[]) {
    db.consultantPayout.findFirst.mockResolvedValue(failed);
    db.consultantPayout.updateMany.mockImplementation(
      async ({ where }: { where: { status: unknown } }) => ({
        count: where.status === "FAILED" ? 1 : 0,
      }),
    );
    db.consultantEarnings.updateMany.mockResolvedValue({
      count: stillAttached.length,
    });
    db.consultantPayout.findUniqueOrThrow.mockResolvedValue({
      ...failed,
      status: "COMPLETED",
      earnings: stillAttached,
    });
    db.consultantEarnings.findMany.mockResolvedValue(stillAttached);
  }

  it("re-attaches the earnings still READY and claws back nothing", async () => {
    arrange([earning("e1", 60_000), earning("e2", 40_000)]);

    await handlePayoutWebhook("RAZORPAY", "pout_1", "COMPLETED");

    expect(db.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: { releasedFromPayoutId: "po_1", status: "READY", payoutId: null },
      data: { payoutId: "po_1", status: "BATCHED" },
    });
    expect(postConsultantPayoutClawback).not.toHaveBeenCalled();
    expect(postLedgerTxn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ idempotencyKey: "payout:po_1" }),
    );
  });

  it("raises a clawback receivable for the earnings already re-batched elsewhere", async () => {
    arrange([earning("e1", 60_000)]);

    await handlePayoutWebhook("RAZORPAY", "pout_1", "COMPLETED");

    expect(postConsultantPayoutClawback).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        consultantPayoutId: "po_1",
        amountPaise: 40_000,
      }),
    );
    expect(reportSentryMessage).toHaveBeenCalledWith(
      "PAYOUT_COMPLETED_AFTER_LOCAL_FAILED",
      expect.objectContaining({
        extra: expect.objectContaining({ clawbackPaise: 40_000 }),
      }),
    );
  });
});

it("FIN-26: a reversed payout voids the clawback raised on it, mirrored", async () => {
  const account = (kind: string) => ({
    kind,
    organizationId: null,
    consultantProfileId: "cp_1",
  });
  db.ledgerTransaction.findMany.mockResolvedValueOnce([
    {
      idempotencyKey: "clawback:rf_1:po_0",
      kind: "PAYOUT",
      entries: [
        {
          direction: "DEBIT",
          amountPaise: 40_000,
          account: account("CONSULTANT_RECEIVABLE"),
        },
        {
          direction: "CREDIT",
          amountPaise: 40_000,
          account: account("CONSULTANT_PAYABLE"),
        },
      ],
    },
  ]);

  await voidClawbacksRaisedOnPayout(db as never, "po_0");

  expect(db.ledgerTransaction.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { payoutId: "po_0", idempotencyKey: { startsWith: "clawback:" } },
    }),
  );
  expect(postLedgerTxn).toHaveBeenCalledWith(
    db,
    expect.objectContaining({
      idempotencyKey: "clawback-void:clawback:rf_1:po_0",
      postings: [
        expect.objectContaining({ direction: "CREDIT", amountPaise: 40_000 }),
        expect.objectContaining({ direction: "DEBIT", amountPaise: 40_000 }),
      ],
    }),
  );
});

it("F4: a frozen or cooling-off default account is not payable", () => {
  const gate = {
    livePayoutsEnabled: true,
    isIndianResident: true,
    readyAmount: 100_000,
    minimumAmount: 50_000,
    outstandingClawbackPaise: 0,
    clawbackPausePaise: 1_000_000,
    now: new Date("2026-10-20T00:00:00Z"),
  };
  expect(
    payoutEligibilityReason({
      ...gate,
      defaultAccount: {
        isVerified: true,
        payoutsAllowedAfter: new Date("2026-10-21T00:00:00Z"),
      },
    }),
  ).toBe("PAYOUT_ACCOUNT_COOLING_OFF");
  expect(
    payoutEligibilityReason({
      ...gate,
      defaultAccount: { isVerified: true, payoutsFrozenAt: gate.now },
    }),
  ).toBe("PAYOUT_ACCOUNT_FROZEN");
});

describe("F1: RazorpayX static egress", () => {
  const live = () =>
    new RazorpayPayoutsService({
      keyId: "rzp_live_x",
      keySecret: "s",
      accountNumber: "acc",
    });
  afterEach(() => {
    delete process.env.RAZORPAYX_EGRESS_PROXY_URL;
  });

  it("refuses a live-key call without the proxy, before any request leaves", async () => {
    const globalFetch = jest.spyOn(global, "fetch");
    await expect(live().fetchPayout("pout_1")).rejects.toMatchObject({
      code: "RAZORPAYX_EGRESS_NOT_CONFIGURED",
    });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("sends through one per-process ProxyAgent when the proxy is set", async () => {
    process.env.RAZORPAYX_EGRESS_PROXY_URL = "http://proxy.test:3128";
    await live().fetchPayout("pout_1");
    await live().fetchPayout("pout_2");

    expect(proxyAgents).toEqual(["http://proxy.test:3128"]);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(undiciFetch.mock.calls[0][1]).toHaveProperty("dispatcher");
  });
});
