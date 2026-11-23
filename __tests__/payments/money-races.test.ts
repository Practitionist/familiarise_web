/**
 * @jest-environment node
 */

/**
 * Racing money writers over shared in-memory rows. Each rival is the real
 * production function; they interleave at a controlled point (a hook that runs
 * after one of them has read, before it writes), so the only thing separating
 * the outcomes is the predicate each CAS repeats in its `where` clause and the
 * count-0 refusal that follows when it loses.
 */

import fc from "fast-check";
import {
  billingTable,
  earningsTable,
  hooks,
  holdsTable,
  payoutsTable,
  resetRaceWorld,
  seedEarning,
  seedPayment,
  state,
  type Row,
} from "../fixtures/money-race-world";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual<typeof import("../fixtures/money-race-world")>(
    "../fixtures/money-race-world",
  ).prismaStub,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn().mockResolvedValue(0),
  getFYDateRange: jest.fn(),
  getIndianFinancialYear: jest.fn().mockReturnValue("2026-27"),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
// The clawback recovery reads and writes the ledger, which this suite does not model.
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  outstandingClawbackPaise: jest.fn().mockResolvedValue(0),
  recoverClawbackOnPayout: jest.fn().mockResolvedValue(0),
  releaseClawbackRecovery: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => null,
  withRazorpaySdkTimeout: (_op: string, call: () => unknown) => call(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn(),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn(),
  remainingOrgInvoiceCreditPaise: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(async () => 0),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
  errorMessageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(async () => null),
  notifyDisputeCreated: jest.fn(async () => []),
  notifyDisputeResolved: jest.fn(async () => []),
  attemptTrigger: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
  notifyPayoutFailed: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { WEBHOOK: 1000 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "refund", DISPUTE_NOTICE: "dispute" },
  stageRefundProcessedEmail: jest.fn(async () => []),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/senders/money", () => ({
  sendOrgBillingEmail: jest.fn(),
  stageDisputeNoticeEmail: jest.fn(async () => []),
}));

import { handleDisputeCreated } from "../../app/api/webhooks/utils";
import {
  createPayoutBatch,
  processApprovedPayouts,
} from "../../lib/payments/payouts/payout-service";
import { applyCappedEarningReversal } from "../../lib/payments/payouts/earning-reversal-cas";
import {
  WalletInsufficientFundsError,
  walletDebit,
} from "../../lib/api/organizations/wallet";
import type { Tx } from "../../lib/prisma";

const CONFIG = { seed: 2230, numRuns: 200 };

let gatewayFetch: jest.Mock;

function stubGlobalFetch(mock: jest.Mock): void {
  Object.defineProperty(globalThis, "fetch", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

const openDispute = () =>
  handleDisputeCreated(
    "disp_1",
    "gw_pay-1",
    1_000_000,
    "INR",
    "fraud",
    "open",
    null,
    false,
  );

const activeHolds = (earningId: unknown) =>
  state.holds.filter(
    (h) => h.consultantEarningsId === earningId && h.releasedAt === undefined,
  );

/** An earning is HELD or BATCHED, never both, and each state carries its own link. */
function expectNeverHeldAndBatched() {
  for (const e of state.earnings) {
    const held = activeHolds(e.id).length > 0;
    expect(!(e.status === "BATCHED" && held)).toBe(true);
    if (e.status === "HELD") {
      expect(e.payoutId).toBeNull();
      expect(held).toBe(true);
    }
    if (e.status === "BATCHED") expect(e.payoutId).not.toBeNull();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRaceWorld();
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  process.env.RAZORPAYX_KEY_SECRET = "x";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  gatewayFetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) });
  stubGlobalFetch(gatewayFetch);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("a dispute opening against a payout batching the same earning", () => {
  it("batching first: the dispute cancels the open payout by CAS, then holds the freed earning", async () => {
    seedEarning();
    const batch = await createPayoutBatch();
    expect(batch.minted).toBe(1);
    expect(state.earnings[0]).toMatchObject({
      status: "BATCHED",
      payoutId: "po-1",
    });
    expect(state.payouts[0].status).toBe("APPROVED");

    await openDispute();

    expect(payoutsTable.updateMany).toHaveBeenCalledWith({
      where: { id: "po-1", status: { in: ["PENDING", "APPROVED"] } },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(state.payouts[0].status).toBe("CANCELLED");
    expect(state.earnings[0]).toMatchObject({
      status: "HELD",
      payoutId: null,
      preHoldStatus: "READY",
    });
    expect(activeHolds("ce-1")).toHaveLength(1);
    expectNeverHeldAndBatched();

    // The cancelled payout is no longer approved, so nothing reaches the gateway.
    expect(await processApprovedPayouts()).toEqual([]);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("the dispute first: the held earning is invisible to batching, so no payout is minted", async () => {
    seedEarning();
    await openDispute();
    expect(state.earnings[0].status).toBe("HELD");

    const batch = await createPayoutBatch();

    expect(batch).toMatchObject({ minted: 0, failed: 0 });
    expect(state.payouts).toHaveLength(0);
    expect(state.earnings[0]).toMatchObject({ status: "HELD", payoutId: null });
    expectNeverHeldAndBatched();
  });

  it("the dispute lands between batching's read and its claim: the claim matches nothing and the mint rolls back", async () => {
    seedEarning();
    hooks.afterReadyEarningsRead = async () => {
      await openDispute();
    };

    const batch = await createPayoutBatch();

    expect(batch).toMatchObject({ minted: 0, failed: 1 });
    const claim = earningsTable.updateMany.mock.calls.findIndex(
      ([args]) => (args.data as Row).status === "BATCHED",
    );
    expect(earningsTable.updateMany.mock.calls[claim][0]).toEqual({
      where: {
        id: { in: ["ce-1"] },
        status: "READY",
        payoutId: null,
      },
      data: { payoutId: "po-1", status: "BATCHED" },
    });
    await expect(
      earningsTable.updateMany.mock.results[claim].value,
    ).resolves.toEqual({
      count: 0,
    });
    expect(state.payouts).toHaveLength(0);
    expect(state.earnings[0]).toMatchObject({ status: "HELD", payoutId: null });
    expectNeverHeldAndBatched();
  });

  it("the payout is read as approved and the dispute lands before its claim: the claim gate refuses and nothing is paid", async () => {
    seedEarning();
    await createPayoutBatch();
    hooks.afterApprovedPayoutsRead = async () => {
      await openDispute();
    };

    const results = await processApprovedPayouts();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ payoutId: "po-1", success: false });
    expect(gatewayFetch).not.toHaveBeenCalled();
    // The gate's own CAS on the already-cancelled payout matched nothing.
    const failCas = payoutsTable.updateMany.mock.calls.find(
      ([args]) => (args.data as Row).status === "FAILED",
    );
    expect(failCas?.[0].where).toEqual({
      id: "po-1",
      status: "APPROVED",
      providerPayoutId: null,
    });
    const failIndex = payoutsTable.updateMany.mock.calls.indexOf(failCas!);
    await expect(
      payoutsTable.updateMany.mock.results[failIndex].value,
    ).resolves.toEqual({ count: 0 });
    expect(state.payouts[0].status).toBe("CANCELLED");
    expect(state.earnings[0].status).toBe("HELD");
    expectNeverHeldAndBatched();
  });

  it("the payout is claimed first: the dispute's cancel CAS loses, the earning stays batched and is never held", async () => {
    seedEarning();
    await createPayoutBatch();
    hooks.afterOpenPayoutEarningsRead = async () => {
      await payoutsTable.updateMany({
        where: { id: "po-1", status: "APPROVED" },
        data: { status: "PROCESSING" },
      });
    };

    await openDispute();

    const cancel = payoutsTable.updateMany.mock.calls.findIndex(
      ([args]) => (args.data as Row).status === "CANCELLED",
    );
    expect(payoutsTable.updateMany.mock.calls[cancel][0].where).toEqual({
      id: "po-1",
      status: { in: ["PENDING", "APPROVED"] },
    });
    await expect(
      payoutsTable.updateMany.mock.results[cancel].value,
    ).resolves.toEqual({ count: 0 });
    expect(state.payouts[0].status).toBe("PROCESSING");
    expect(state.earnings[0]).toMatchObject({
      status: "BATCHED",
      payoutId: "po-1",
    });
    expect(holdsTable.createMany).not.toHaveBeenCalled();
    expectNeverHeldAndBatched();
  });
});

describe("a refund against a payout of the same earning", () => {
  const request = { id: "ce-1", consultantSharePaise: 400_000 };

  it("the refund reverses the whole share between batching's read and its claim: the claim matches nothing and no payout is minted", async () => {
    seedEarning();
    hooks.afterReadyEarningsRead = async () => {
      await applyCappedEarningReversal(
        { consultantEarnings: earningsTable } as never,
        { ...request, refundedShareAmount: 0, status: "READY" },
        400_000,
      );
    };

    const batch = await createPayoutBatch();

    expect(batch).toMatchObject({ minted: 0, failed: 1 });
    expect(state.payouts).toHaveLength(0);
    expect(state.earnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 400_000,
      payoutId: null,
    });
  });

  it("batching commits under the refund's stale read: the refund's first CAS loses, re-reads BATCHED and lands on that status", async () => {
    seedEarning();
    const stale = {
      ...request,
      refundedShareAmount: 0,
      status: "READY" as const,
    };
    await createPayoutBatch();

    const outcome = await applyCappedEarningReversal(
      { consultantEarnings: earningsTable } as never,
      stale,
      150_000,
    );

    const reversalCalls = earningsTable.updateMany.mock.calls
      .map(([args]) => args)
      .filter((a) => (a.data as Row).refundedShareAmount !== undefined);
    expect(reversalCalls.map((a) => a.where)).toEqual([
      { id: "ce-1", status: "READY", refundedShareAmount: 0 },
      { id: "ce-1", status: "BATCHED", refundedShareAmount: 0 },
    ]);
    expect(outcome).toMatchObject({
      reversedPaise: 150_000,
      refundedShareAmount: 150_000,
      lostRace: true,
    });
    expect(state.earnings[0]).toMatchObject({
      status: "BATCHED",
      payoutId: "po-1",
      refundedShareAmount: 150_000,
    });
  });

  it("the reversal committed after batching leaves the payout short: the claim gate fails it without a gateway call and the net share re-batches", async () => {
    seedEarning();
    await createPayoutBatch();
    await applyCappedEarningReversal(
      { consultantEarnings: earningsTable } as never,
      { ...request, refundedShareAmount: 0, status: "BATCHED" },
      150_000,
    );

    const results = await processApprovedPayouts();

    expect(results[0]).toMatchObject({
      payoutId: "po-1",
      success: false,
      error: expect.stringMatching(/^SHORTFALL_BEFORE_DISBURSEMENT/),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(state.payouts[0].status).toBe("FAILED");
    expect(state.earnings[0]).toMatchObject({
      status: "READY",
      payoutId: null,
      refundedShareAmount: 150_000,
    });

    await createPayoutBatch();
    expect(state.payouts[1].amount).toBe(250_000);
  });

  it("a refund that appears after the payout was read as approved blocks the claim before any CAS or gateway call", async () => {
    const payment = seedPayment();
    seedEarning();
    await createPayoutBatch();
    hooks.afterApprovedPayoutsRead = async () => {
      (payment.refunds as Row[]).push({
        amountPaise: 150_000,
        status: "PENDING",
        cascadedAt: null,
      });
    };

    const results = await processApprovedPayouts();

    expect(results[0]).toMatchObject({
      payoutId: "po-1",
      success: false,
      skipped: true,
    });
    expect(
      payoutsTable.updateMany.mock.calls.some(
        ([args]) => (args.data as Row).status === "PROCESSING",
      ),
    ).toBe(false);
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(state.payouts[0].status).toBe("APPROVED");
    expect(state.earnings[0]).toMatchObject({
      status: "BATCHED",
      payoutId: "po-1",
    });
  });
});

describe("two concurrent wallet debits", () => {
  const ACCOUNT = "ba-1";

  /** A transaction whose debit guard waits until every contender has reached it. */
  function contendedTx(contenders: number, delays: number[] = []) {
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let index = 0;
    return (): Tx => {
      const mine = index++;
      return {
        billingAccount: {
          ...billingTable,
          updateMany: async (args: {
            where?: { walletBalance?: unknown };
            data: Row;
          }) => {
            const isDebitGuard =
              typeof args.where?.walletBalance === "object" &&
              args.where?.walletBalance !== null;
            if (isDebitGuard) {
              for (let i = 0; i < (delays[mine] ?? 0); i++)
                await Promise.resolve();
              arrived++;
              if (arrived >= contenders) release();
              await gate;
            }
            return billingTable.updateMany(args);
          },
        },
      } as unknown as Tx;
    };
  }

  beforeEach(() => {
    state.billing.push({ id: ACCOUNT, walletBalance: 1_000, currency: "INR" });
  });

  it("when the sum exceeds the balance exactly one succeeds, and the loser is refused on count 0", async () => {
    const txFor = contendedTx(2);
    const debit = (tx: Tx) =>
      walletDebit(tx, {
        billingAccountId: ACCOUNT,
        amountPaise: 700,
        reason: "BOOKING_DEBIT" as never,
      });

    const settled = await Promise.allSettled([debit(txFor()), debit(txFor())]);

    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WalletInsufficientFundsError,
    );
    expect(state.billing[0].walletBalance).toBe(300);

    const guards = billingTable.updateMany.mock.calls
      .map(([args]) => args)
      .filter(
        (a) =>
          typeof a.where?.walletBalance === "object" &&
          a.where?.walletBalance !== null,
      );
    expect(guards.map((a) => a.where)).toEqual([
      { id: ACCOUNT, walletBalance: { gte: 700 } },
      { id: ACCOUNT, walletBalance: { gte: 700 } },
    ]);
    const outcomes = await Promise.all(
      billingTable.updateMany.mock.results
        .filter((_, i) => {
          const w =
            billingTable.updateMany.mock.calls[i][0].where?.walletBalance;
          return typeof w === "object" && w !== null;
        })
        .map((r) => r.value as Promise<{ count: number }>),
    );
    expect(outcomes.map((o) => o.count).sort()).toEqual([0, 1]);
  });

  it("a debit equal to the whole balance and one more paisa: exactly one wins, the balance never goes negative", async () => {
    state.billing[0].walletBalance = 500;
    const txFor = contendedTx(2);

    const settled = await Promise.allSettled(
      [500, 1].map((amountPaise) =>
        walletDebit(txFor(), {
          billingAccountId: ACCOUNT,
          amountPaise,
          reason: "BOOKING_DEBIT" as never,
        }),
      ),
    );

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number(state.billing[0].walletBalance)).toBeGreaterThanOrEqual(0);
  });

  it("an account whose cached balance is NULL is seeded to zero and refuses both debits", async () => {
    state.billing[0].walletBalance = null;
    const txFor = contendedTx(2);

    const settled = await Promise.allSettled(
      [100, 100].map(() =>
        walletDebit(txFor(), {
          billingAccountId: ACCOUNT,
          amountPaise: 100,
          reason: "BOOKING_DEBIT" as never,
        }),
      ),
    );

    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(state.billing[0].walletBalance).toBe(0);
  });

  it("for any balance, amounts and scheduling, the accepted debits never exceed the balance and the cache matches them", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5_000 }),
        fc.array(fc.integer({ min: 1, max: 3_000 }), {
          minLength: 2,
          maxLength: 6,
        }),
        fc.array(fc.integer({ min: 0, max: 5 }), {
          minLength: 6,
          maxLength: 6,
        }),
        async (initial, amounts, delays) => {
          state.billing[0].walletBalance = initial;
          const txFor = contendedTx(amounts.length, delays);

          const settled = await Promise.allSettled(
            amounts.map((amountPaise) =>
              walletDebit(txFor(), {
                billingAccountId: ACCOUNT,
                amountPaise,
                reason: "BOOKING_DEBIT" as never,
              }),
            ),
          );

          const accepted = amounts.filter(
            (_, i) => settled[i].status === "fulfilled",
          );
          const acceptedSum = accepted.reduce((a, b) => a + b, 0);
          expect(acceptedSum).toBeLessThanOrEqual(initial);
          expect(state.billing[0].walletBalance).toBe(initial - acceptedSum);
          const refusals = settled.flatMap((r) =>
            r.status === "rejected" ? [r.reason] : [],
          );
          expect(
            refusals.every((e) => e instanceof WalletInsufficientFundsError),
          ).toBe(true);
        },
      ),
      CONFIG,
    );
  });
});
