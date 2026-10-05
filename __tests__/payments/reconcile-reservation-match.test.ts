/**
 * @jest-environment node
 */

/**
 * Refund reconcile matcher (money-hardening pass).
 *
 * The old matcher required `gateway metadata.created`, which NO writer ever
 * set — it could never match, so every placeholder was force-FAILED at 24h
 * even when the refund HAD landed. Failing restores the refundable balance,
 * ops retries under a fresh idempotency key, and the gateway issues a SECOND
 * refund: platform loss. Recovery is also bound by Stripe's 24h idempotency
 * key retention / Razorpay's no-self-serve-replay: "fail locally, retry under
 * a new key" is never safe without a gateway lookup first.
 *
 * Under test:
 *   - exact bind on notes.reservationId (the identity we ride to the gateway);
 *   - FAIL only after 24h AND a succeeded listing with no reservation match;
 *   - ambiguous legacy candidates (multiple amount matches, no ids) stay
 *     PENDING and page instead of guessing;
 *   - real-id PENDING rows are polled via getRefund and settled.
 */
jest.mock("../../lib/prisma", () => {
  const refund = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    delete: jest.fn().mockResolvedValue({}),
  };
  // No credit was spent on these payments, so credit restoration finds nothing.
  const referralCreditUsage = { findMany: jest.fn().mockResolvedValue([]) };
  return {
    __esModule: true,
    default: {
      refund,
      // The stranded-refund backstop selects its cohort ids with raw SQL.
      $queryRaw: jest.fn(),
      // #1589 N-P0-01 — the SUCCEEDED mark now runs in its own tx with the
      // payer's notice; the tx sees the same refund table.
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ refund, referralCreditUsage }),
      ),
    },
  };
});
const mockNotifyRefundProcessed = jest.fn().mockResolvedValue(null);
jest.mock("../../lib/novu/outbox", () => ({
  attemptTrigger: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "REFUND_PROCESSED" },
  sendRefundFailedEmail: jest.fn(),
  stageRefundProcessedEmail: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));
jest.mock("../../lib/payments", () => ({
  listRefunds: jest.fn(),
  getRefund: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundFailed: jest.fn().mockResolvedValue(undefined),
  notifyRefundProcessed: (...a: unknown[]) => mockNotifyRefundProcessed(...a),
}));
const mockApplyRefundCascade = jest.fn().mockResolvedValue({});
const mockRefundSidePayment = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: (...a: unknown[]) => mockApplyRefundCascade(...a),
  refundMemberOverageSidePayment: (...a: unknown[]) =>
    mockRefundSidePayment(...a),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  // Passthrough — the lock machinery has its own suite; these tests own the
  // matcher semantics.
  withCronLock: (_key: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
  LONG_JOB_TTL_MS: 35 * 60_000,
}));

import prisma from "../../lib/prisma";
import { listRefunds, getRefund } from "../../lib/payments";
import { RefundError } from "../../lib/payments/core/types";
import { reportSentryMessage } from "../../lib/observability/report";
import { notifyRefundFailed } from "../../lib/novu/service";
import { reverseCreditsForPayment } from "../../lib/referrals/service";
import { reconcilePendingRefunds } from "../../scripts/refunds/reconcile-pending-refunds";

/** The Prisma refund surface the reconcile core touches. */
interface ReconcileRefundMock {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  delete: jest.Mock;
}
interface ReconcilePrismaMock {
  refund: ReconcileRefundMock;
  $queryRaw: jest.Mock;
}

// Single seam over the generated client (repo-wide mock idiom).
const refundTable = (prisma as unknown as ReconcilePrismaMock).refund;
const mockStrandedIds = (prisma as unknown as ReconcilePrismaMock).$queryRaw;
const mockList = listRefunds as jest.Mock;
const mockGet = getRefund as jest.Mock;
const mockPage = reportSentryMessage as jest.Mock;
const mockNotifyFailed = notifyRefundFailed as jest.Mock;

const HOUR = 60 * 60 * 1000;

/** A stale placeholder row as the reconcile core's selector sees it. */
interface PlaceholderRow {
  id: string;
  refundId: string;
  status: "PENDING";
  amountPaise: number;
  createdAt: Date;
  metadata: Record<string, string>;
  payment: { paymentIntent: string; paymentGateway: "RAZORPAY" | "STRIPE" };
  ageHours?: number;
}

function placeholderRow(
  overrides: Partial<PlaceholderRow> = {},
): PlaceholderRow {
  const ageHours = overrides.ageHours ?? 2;
  const { ageHours: _ignored, ...rest } = overrides;
  void _ignored;
  return {
    id: "res_1",
    refundId: "pending_uuid-1",
    status: "PENDING",
    amountPaise: 10_000,
    createdAt: new Date(Date.now() - ageHours * HOUR),
    metadata: {},
    payment: {
      paymentIntent: "order_1",
      paymentGateway: "RAZORPAY",
    },
    ...rest,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  refundTable.findUnique.mockResolvedValue(null);
  refundTable.findMany.mockResolvedValue([]);
  // The stranded-refund backstop pass finds nothing unless a test says so.
  mockStrandedIds.mockResolvedValue([]);
});

describe("reconcilePendingRefunds placeholder matching", () => {
  test("binds exactly on notes.reservationId === the reservation row id", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow()])
      .mockResolvedValueOnce([]); // real-id pass
    mockList.mockResolvedValueOnce([
      {
        refundId: "rfnd_exact",
        amount: 10_000,
        currency: "INR",
        status: "processed",
        metadata: { reservationId: "res_1" }, // what Phase 2 rode to the gateway
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.reconciledCount).toBe(1);
    expect(refundTable.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1" },
        data: expect.objectContaining({
          refundId: "rfnd_exact",
          status: "SUCCEEDED",
        }),
      }),
    );
    // Never failed while a match existed.
    expect(result.failedCount).toBe(0);
  });

  test("FAILs a >24h placeholder only when the listing succeeded and no reservation match exists", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
      .mockResolvedValueOnce([]);
    // Gateway listing SUCCEEDED — genuinely no refund landed for this key.
    mockList.mockResolvedValueOnce([
      {
        refundId: "rfnd_other",
        amount: 55_555,
        status: "processed",
        metadata: { reservationId: "res_someone_else" },
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(1);
    // CAS on PENDING: a `refund.created` webhook binding the row to SUCCEEDED
    // between the read and this write must win (count 0 → skip), never be
    // clobbered back to FAILED.
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1", status: "PENDING" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  test("a young unmatched placeholder stays PENDING within the grace window", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 2 })])
      .mockResolvedValueOnce([]);
    mockList.mockResolvedValueOnce([]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
    expect(refundTable.update).not.toHaveBeenCalled();
  });

  test("ambiguous legacy candidates stay PENDING and page instead of guessing", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ ageHours: 30, metadata: { source: "app" } }),
      ])
      .mockResolvedValueOnce([]);
    // Two same-amount gateway refunds carrying NO reservation id — binding
    // either would be a coin flip on someone else's money.
    mockList.mockResolvedValueOnce([
      { refundId: "rfnd_a", amount: 10_000, status: "processed", metadata: {} },
      { refundId: "rfnd_b", amount: 10_000, status: "processed", metadata: {} },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(refundTable.update).not.toHaveBeenCalled();
    expect(mockPage).toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous"),
      expect.objectContaining({ tags: { feature: "refund-reconcile" } }),
    );
  });
});

// Prod 2026-10-01: orders.fetchPayments 404'd for five stale placeholders and
// failed every run. Past 24h the row is FAILED and paged once; younger waits.
describe("reconcilePendingRefunds — placeholder whose order the gateway does not know", () => {
  const orderNotFound = () =>
    new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY", {
      statusCode: 404,
      error: undefined,
    });

  test("past 24h → FAILED via CAS, paged once, batch continues, run succeeds", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ id: "res_a", ageHours: 30 }),
        placeholderRow({ id: "res_b", ageHours: 30 }),
      ])
      .mockResolvedValueOnce([]);
    mockList
      .mockRejectedValueOnce(orderNotFound())
      .mockRejectedValueOnce(orderNotFound());

    const result = await reconcilePendingRefunds();

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_b", status: "PENDING" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      failedCount: 2,
      failedUnknownId: 2,
      errors: [],
    });
    expect(mockPage).toHaveBeenCalledTimes(1);
    expect(mockPage.mock.calls[0][1]).toMatchObject({
      extra: { failed: ["res_a", "res_b"] },
    });
  });

  test("within 24h → left PENDING and skipped; any other list error stays an error", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ id: "res_young", ageHours: 2 }),
        placeholderRow({ id: "res_flaky", ageHours: 30 }),
      ])
      .mockResolvedValueOnce([]);
    mockList.mockRejectedValueOnce(orderNotFound()).mockRejectedValueOnce(
      new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY", {
        statusCode: 502,
      }),
    );

    const result = await reconcilePendingRefunds();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(result.errors).toEqual([
      "Refund res_flaky: Failed to process refund",
    ]);
    expect(result.success).toBe(false);
    expect(mockPage).not.toHaveBeenCalled();
  });
});

describe("reconcilePendingRefunds real-id PENDING polling", () => {
  test("polls getRefund and settles a lost-webhook confirmation", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([]) // no placeholders
      .mockResolvedValueOnce([
        {
          id: "row_9",
          refundId: "rfnd_real",
          status: "PENDING",
          amountPaise: 10_000,
          currency: "INR",
          createdAt: new Date(Date.now() - 3 * HOUR),
          payment: {
            id: "pay-9",
            paymentGateway: "RAZORPAY",
            userId: "user-9",
            organizationId: null,
          },
        },
      ]);
    mockGet.mockResolvedValueOnce({
      refundId: "rfnd_real",
      amount: 10_000,
      currency: "INR",
      status: "SUCCEEDED", // mapper output, not the raw gateway string
      metadata: undefined,
    });

    const result = await reconcilePendingRefunds();

    expect(mockGet).toHaveBeenCalledWith("rfnd_real", "RAZORPAY");
    expect(result.reconciledCount).toBe(1);
    // CodeRabbit r1 — the mark is a CAS on PENDING so a re-entrant run or a
    // webhook that settled the row first cannot mark or notify twice.
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row_9", status: "PENDING" },
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
    // #1589 N-P0-01 — the mark stands in for the lost webhook, so it owes the
    // payer the same notice, staged through the mark's own tx.
    expect(mockNotifyRefundProcessed).toHaveBeenCalledWith(
      "user-9",
      expect.objectContaining({ amount: 10_000, currency: "INR" }),
      expect.objectContaining({ entityRef: "payment:pay-9" }),
    );
  });

  test("a row another writer already settled is neither re-marked nor re-notified", async () => {
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "row_9",
        refundId: "rfnd_real",
        status: "PENDING",
        amountPaise: 10_000,
        currency: "INR",
        createdAt: new Date(Date.now() - 3 * HOUR),
        payment: {
          id: "pay-9",
          paymentGateway: "RAZORPAY",
          userId: "user-9",
          organizationId: null,
        },
      },
    ]);
    mockGet.mockResolvedValueOnce({
      refundId: "rfnd_real",
      amount: 10_000,
      currency: "INR",
      status: "SUCCEEDED",
      metadata: undefined,
    });
    refundTable.updateMany.mockResolvedValueOnce({ count: 0 }); // lost the claim

    const result = await reconcilePendingRefunds();

    expect(result.reconciledCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(mockNotifyRefundProcessed).not.toHaveBeenCalled();
  });

  test("a still-settling real-id refund is never aged out locally", async () => {
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "row_9",
        refundId: "rfnd_real",
        status: "PENDING",
        amountPaise: 10_000,
        createdAt: new Date(Date.now() - 72 * HOUR), // 3 days old
        payment: { paymentGateway: "RAZORPAY" },
      },
    ]);
    mockGet.mockResolvedValueOnce({
      refundId: "rfnd_real",
      amount: 10_000,
      currency: "INR",
      status: "PENDING", // normal-speed refunds take 5–7 business days
      metadata: undefined,
    });

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(refundTable.update).not.toHaveBeenCalled();
  });

  // FAMILIARISE_WEB-3V — Razorpay answers an id it has never seen (or a
  // test-mode id read with live keys) with 400 BAD_REQUEST_ERROR /
  // input_validation_failed, never 404. Polling it again cannot help, so the
  // row is FAILED through a CAS on PENDING; any other error keeps retrying.
  test("an id the gateway has no record of is FAILED once via CAS; other errors keep polling", async () => {
    const row = {
      id: "row_ghost",
      refundId: "rfnd_ghost00000001",
      status: "PENDING",
      amountPaise: 10_000,
      createdAt: new Date(Date.now() - 3 * HOUR),
      payment: { paymentGateway: "RAZORPAY" },
    };
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    mockGet.mockRejectedValueOnce(
      new RefundError(
        "invalid request sent",
        "BAD_REQUEST_ERROR",
        "RAZORPAY",
        undefined,
        "input_validation_failed",
      ),
    );

    const terminal = await reconcilePendingRefunds();

    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row_ghost", status: "PENDING" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(terminal.failedUnknownId).toBe(1);
    expect(terminal.failedCount).toBe(1);
    expect(terminal.errors).toEqual([]);
    expect(mockPage).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    mockGet.mockRejectedValueOnce(
      new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY"),
    );

    const transient = await reconcilePendingRefunds();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(refundTable.update).not.toHaveBeenCalled();
    expect(transient.failedUnknownId).toBe(0);
    expect(transient.errors).toHaveLength(1);

    // A webhook settled the row between the select and the CAS: the claim
    // loses (count 0), so nothing is counted, paged, or errored.
    jest.clearAllMocks();
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    refundTable.updateMany.mockResolvedValueOnce({ count: 0 });
    mockGet.mockRejectedValueOnce(
      new RefundError(
        "invalid request sent",
        "BAD_REQUEST_ERROR",
        "RAZORPAY",
        undefined,
        "input_validation_failed",
      ),
    );

    const lost = await reconcilePendingRefunds();

    expect(refundTable.updateMany).toHaveBeenCalledTimes(1);
    expect(lost.failedUnknownId).toBe(0);
    expect(lost.failedCount).toBe(0);
    expect(lost.errors).toEqual([]);
    expect(mockPage).not.toHaveBeenCalled();
  });

  // A refund on a gateway with no implementation is skipped, never polled.
  test("a young STRIPE refund is skipped and counted, not failed", async () => {
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "row_stripe",
        refundId: "re_real",
        status: "PENDING",
        amountPaise: 10_000,
        createdAt: new Date(Date.now() - 3 * HOUR),
        payment: { paymentGateway: "STRIPE" },
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

/**
 * A real-id PENDING refund on a gateway with no implementation is retired
 * FAILED/GATEWAY_DISABLED past 24 h through the PENDING-guarded CAS, reported once.
 */
describe("reconcilePendingRefunds — no live client past 24h", () => {
  test("a 3-day-old PENDING STRIPE refund → FAILED once", async () => {
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "row_stripe_old",
        refundId: "re_real_old",
        status: "PENDING",
        amountPaise: 10_000,
        createdAt: new Date(Date.now() - 72 * HOUR),
        payment: { paymentGateway: "STRIPE" },
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(mockGet).not.toHaveBeenCalled();
    expect(refundTable.updateMany).toHaveBeenCalledTimes(1);
    expect(refundTable.updateMany).toHaveBeenCalledWith({
      where: { id: "row_stripe_old", status: "PENDING" },
      data: expect.objectContaining({
        status: "FAILED",
        failureReason: "GATEWAY_DISABLED",
      }),
    });
    expect(result.failedGatewayDisabled).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.success).toBe(true);
    expect(mockPage).toHaveBeenCalledTimes(1);
    expect(mockPage.mock.calls[0][1]).toMatchObject({
      expected: true,
      extra: { retired: ["row_stripe_old"] },
    });
  });
});

// The notify pass runs inside the core, after both reconcile passes, so every
// door that reconciles also pages the payer of a FAILED refund exactly once.
describe("reconcilePendingRefunds — failed-refund notice", () => {
  test("pages the payer of an un-notified FAILED refund after reconciling", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([]) // placeholder pass
      .mockResolvedValueOnce([]) // real-id pass
      .mockResolvedValueOnce([
        {
          id: "row_failed",
          paymentId: "pay_1",
          amountPaise: 10_000,
          currency: "INR",
          metadata: {},
          failureReason: null,
          failedAt: null,
          payment: { userId: "user_1", organizationId: null },
        },
      ]);

    await reconcilePendingRefunds();

    expect(refundTable.findMany).toHaveBeenCalledTimes(3);
    expect(refundTable.findMany.mock.calls[2][0]).toMatchObject({
      where: { status: "FAILED", failedNotifiedAt: null },
    });
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row_failed", failedNotifiedAt: null },
      }),
    );
    expect(mockNotifyFailed).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({ amount: 10_000 }),
    );
  });
});

describe("reconcilePendingRefunds — stranded-refund backstop", () => {
  test("re-drives with credits and the overage side-payment; a poison row rotates without failing the run", async () => {
    mockStrandedIds.mockResolvedValueOnce([
      { id: "ref_stranded" },
      { id: "ref_broken" },
    ]);
    refundTable.findMany
      .mockResolvedValueOnce([]) // placeholder pass
      .mockResolvedValueOnce([]) // real-id pass
      .mockResolvedValueOnce([
        {
          id: "ref_stranded",
          paymentId: "pay_1",
          amountPaise: 4_000,
          reason: null,
          metadata: null,
          payment: { amount: 10_000 },
        },
        {
          id: "ref_broken",
          paymentId: "pay_2",
          amountPaise: 1_000,
          reason: null,
          metadata: { cascadeRedriveAttempts: 2 },
          payment: { amount: 1_000 },
        },
      ]);
    mockApplyRefundCascade
      .mockResolvedValueOnce({
        memberOverageRefundDue: { overagePaymentId: "pay_side" },
      })
      .mockRejectedValueOnce(new Error("ledger down"));

    const result = await reconcilePendingRefunds();

    expect(reverseCreditsForPayment).toHaveBeenCalledWith(
      "pay_1",
      expect.anything(),
      4_000,
      10_000,
    );
    expect(mockRefundSidePayment).toHaveBeenCalledWith({
      parentPaymentId: "pay_1",
      due: { overagePaymentId: "pay_side" },
      initiatedByUserId: null,
    });
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ref_broken", status: "SUCCEEDED", cascadedAt: null },
        data: expect.objectContaining({
          metadata: { cascadeRedriveAttempts: 3 },
        }),
      }),
    );
    expect(mockPage).toHaveBeenCalledWith(
      expect.stringContaining("1 SUCCEEDED refund(s) dead-lettered"),
      expect.objectContaining({ extra: { refundIds: ["ref_broken"] } }),
    );
    expect(result).toMatchObject({
      redrivenCount: 1,
      redriveFailedCount: 1,
      redriveDeadLettered: 1,
      success: true,
    });
  });
});
