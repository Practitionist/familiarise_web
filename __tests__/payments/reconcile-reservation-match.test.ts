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
 *   - exact bind on notes.reservationId (the identity we ride to the gateway),
 *     searched page by page on the captured gateway payment;
 *   - FAIL only after 24h AND a complete listing with no reservation match AND
 *     these keys reading the capture as captured;
 *   - an unknown-id or 404 answer never fails a refund;
 *   - a same-amount gateway refund without a reservation note stays PENDING
 *     and pages instead of being adopted;
 *   - real-id PENDING rows are polled via getRefund and settled.
 */
jest.mock("../../lib/prisma", () => {
  const refund = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ metadata: {} }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const supportFinancialRecommendation = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  // The owed-refund marker a settled refund is taken off.
  const payment = {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  return {
    __esModule: true,
    default: {
      refund,
      payment,
      supportFinancialRecommendation,
      $executeRaw: jest.fn().mockResolvedValue(1),
      // The stranded-refund backstop selects its cohort ids with raw SQL.
      $queryRaw: jest.fn(),
      // #1589 N-P0-01 — the SUCCEEDED mark now runs in its own tx with the
      // payer's notice; the tx sees the same refund table.
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ refund, payment, supportFinancialRecommendation }),
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
  MONEY_EMAIL_TYPES: {
    REFUND_PROCESSED: "REFUND_PROCESSED",
    REFUND_FAILED: "REFUND_FAILED",
  },
  stageRefundFailedEmail: jest.fn().mockResolvedValue([]),
  stageRefundProcessedEmail: jest.fn().mockResolvedValue([]),
  prepareRefundFailedEmail: jest.fn().mockResolvedValue(null),
  prepareRefundProcessedEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));
jest.mock("../../lib/payments", () => ({
  listRefunds: jest.fn(),
  getRefund: jest.fn(),
}));
const mockStanding = jest.fn();
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: async (args: unknown, report: () => void) => {
    mockStanding(args);
    report();
    return true;
  },
}));
const mockFetchPayment = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  ...jest.requireActual("../../lib/payments/core/razorpay"),
  getRazorpayClient: () => ({
    payments: { fetch: (...a: unknown[]) => mockFetchPayment(...a) },
  }),
  withRazorpaySdkTimeout: (_op: string, call: () => Promise<unknown>) => call(),
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
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: (...a: unknown[]) => mockApplyRefundCascade(...a),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));
const mockSettleSeat = jest.fn(async (..._a: unknown[]) => ({
  endsSeat: false,
  revocationGeneration: null,
}));
jest.mock("../../lib/payments/operations/refund-seat", () => ({
  settleRefundSeatTx: (...a: unknown[]) => mockSettleSeat(...a),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  // Passthrough — the lock machinery has its own suite; these tests own the
  // matcher semantics.
  withCronLock: (_key: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
  LONG_JOB_TTL_MS: 35 * 60_000,
}));

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { listRefunds, getRefund } from "../../lib/payments";
import { RefundError } from "../../lib/payments/core/types";
import { reportSentryMessage } from "../../lib/observability/report";
import { notifyRefundFailed } from "../../lib/novu/service";
import { reverseCreditsForPayment } from "../../lib/referrals/service";
import { stageRefundFailedEmail } from "../../lib/email";
import {
  reconcilePendingRefunds,
  notifyFailedRefunds,
} from "../../scripts/refunds/reconcile-pending-refunds";

/** The Prisma refund surface the reconcile core touches. */
interface ReconcileRefundMock {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  deleteMany: jest.Mock;
}
interface ReconcilePrismaMock {
  refund: ReconcileRefundMock;
  payment: { findUnique: jest.Mock; updateMany: jest.Mock };
  supportFinancialRecommendation: { updateMany: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
}

// Single seam over the generated client (repo-wide mock idiom).
const refundTable = (prisma as unknown as ReconcilePrismaMock).refund;
const paymentTable = (prisma as unknown as ReconcilePrismaMock).payment;
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
  payment: {
    paymentIntent: string;
    gatewayPaymentId: string | null;
    paymentGateway: "RAZORPAY" | "STRIPE";
  };
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
      gatewayPaymentId: "pay_cap1",
      paymentGateway: "RAZORPAY",
    },
    ...rest,
  };
}

const capturedPayment = (over: Record<string, unknown> = {}) => ({
  id: "pay_cap1",
  order_id: "order_1",
  status: "captured",
  amount: 10_000,
  currency: "INR",
  notes: {},
  ...over,
});

/** The gateway's answer for an id these keys have no record of. */
const unknownId = () =>
  new RefundError(
    "invalid request sent",
    "BAD_REQUEST_ERROR",
    "RAZORPAY",
    undefined,
    "input_validation_failed",
  );

beforeEach(() => {
  jest.clearAllMocks();
  refundTable.findUnique.mockResolvedValue(null);
  refundTable.findMany.mockResolvedValue([]);
  // The stranded-refund backstop pass finds nothing unless a test says so.
  mockStrandedIds.mockResolvedValue([]);
  // These keys read the capture unless a test says otherwise.
  mockFetchPayment.mockResolvedValue(capturedPayment());
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
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1", status: "PENDING" },
        data: expect.objectContaining({
          refundId: "rfnd_exact",
          status: "SUCCEEDED",
        }),
      }),
    );
    // Never failed while a match existed.
    expect(result.failedCount).toBe(0);
    // The bind settles the row, so it decides the seat in the same transaction.
    expect(mockSettleSeat).toHaveBeenCalledWith(
      expect.objectContaining({ refund: refundTable }),
      "res_1",
    );
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

    // The search reads the captured gateway payment, one full page at a time.
    expect(mockList).toHaveBeenCalledWith("pay_cap1", "RAZORPAY", 100, 0);
    expect(mockFetchPayment).toHaveBeenCalledWith("pay_cap1");
    expect(result.failedCount).toBe(1);
    // CAS on PENDING and on the placeholder id read at the start: a webhook or
    // the binder that settled the row, or bound it to its gateway refund while
    // the gateway was being asked, must win (count 0 → skip).
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1", status: "PENDING", refundId: "pending_uuid-1" },
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

  test("a single same-amount gateway refund without a reservation note is never adopted or failed", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
      .mockResolvedValueOnce([]);
    mockList.mockResolvedValueOnce([
      { refundId: "rfnd_a", amount: 10_000, status: "processed", metadata: {} },
    ]);

    const result = await reconcilePendingRefunds();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reconciledCount: 0, failedCount: 0 });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:ambiguous",
        ids: ["res_1"],
      }),
    );
  });

  test("a same-amount gateway refund whose reservation note is empty names no reservation and is never failed over", async () => {
    for (const reservationId of ["", "  "]) {
      jest.clearAllMocks();
      refundTable.findMany
        .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
        .mockResolvedValueOnce([]);
      mockList.mockResolvedValueOnce([
        {
          refundId: "rfnd_a",
          amount: 10_000,
          status: "processed",
          metadata: { reservationId },
        },
      ]);

      const result = await reconcilePendingRefunds();

      expect(refundTable.updateMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({ reconciledCount: 0, failedCount: 0 });
      expect(mockStanding).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "reconcile-pending-refunds:ambiguous",
          ids: ["res_1"],
        }),
      );
    }
  });

  test("the search pages past a full first page and binds the reservation on the second", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
      .mockResolvedValueOnce([]);
    const other = (i: number) => ({
      refundId: `rfnd_other_${i}`,
      amount: 55_555,
      status: "processed",
      metadata: { reservationId: `res_other_${i}` },
    });
    mockList
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => other(i)))
      .mockResolvedValueOnce([
        {
          refundId: "rfnd_page2",
          amount: 10_000,
          currency: "INR",
          status: "processed",
          metadata: { reservationId: "res_1" },
        },
      ]);

    const result = await reconcilePendingRefunds();

    expect(mockList).toHaveBeenNthCalledWith(
      2,
      "pay_cap1",
      "RAZORPAY",
      100,
      100,
    );
    expect(result).toMatchObject({ reconciledCount: 1, failedCount: 0 });
    expect(refundTable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1", status: "PENDING" },
        data: expect.objectContaining({ refundId: "rfnd_page2" }),
      }),
    );
  });

  test("a search that reaches the page bound without a short page leaves the row PENDING in the standing finding", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
      .mockResolvedValueOnce([]);
    mockList.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        refundId: `rfnd_other_${i}`,
        amount: 55_555,
        status: "processed",
        metadata: { reservationId: `res_other_${i}` },
      })),
    );

    const result = await reconcilePendingRefunds();
    mockList.mockReset();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failedCount: 0, unknownAtGateway: 1 });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:unknown-at-gateway",
        ids: ["res_1"],
      }),
    );
  });

  test("an empty complete listing does not fail a >24h placeholder unless these keys read the capture as captured", async () => {
    for (const answer of [
      () => Promise.reject(unknownId()),
      () => Promise.resolve(capturedPayment({ status: "refunded" })),
      () => Promise.resolve(capturedPayment({ id: "pay_other" })),
    ]) {
      jest.clearAllMocks();
      refundTable.findMany
        .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
        .mockResolvedValueOnce([]);
      mockList.mockResolvedValueOnce([]);
      mockFetchPayment.mockImplementationOnce(answer);

      const result = await reconcilePendingRefunds();

      expect(refundTable.updateMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        failedCount: 0,
        unknownAtGateway: 1,
        success: true,
      });
      expect(mockStanding).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "reconcile-pending-refunds:unknown-at-gateway",
          ids: ["res_1"],
        }),
      );
    }
  });
});

// An unknown-id or 404 answer also comes back for an id of the other key mode,
// so it never fails a refund: the rows stay PENDING under one standing finding.
describe("reconcilePendingRefunds — the gateway does not know the id under these keys", () => {
  const orderNotFound = () =>
    new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY", {
      statusCode: 404,
      error: undefined,
    });
  const realIdRow = {
    id: "row_ghost",
    refundId: "rfnd_ghost00000001",
    status: "PENDING",
    amountPaise: 10_000,
    createdAt: new Date(Date.now() - 30 * HOUR),
    payment: { paymentGateway: "RAZORPAY" },
  };

  test("placeholders past 24h and a bound refund id all stay PENDING; one finding names the count", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ id: "res_a", ageHours: 30 }),
        placeholderRow({ id: "res_b", ageHours: 30 }),
      ])
      .mockResolvedValueOnce([realIdRow]);
    mockList
      .mockRejectedValueOnce(orderNotFound())
      .mockRejectedValueOnce(unknownId());
    mockGet.mockRejectedValueOnce(unknownId());

    const result = await reconcilePendingRefunds();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      failedCount: 0,
      unknownAtGateway: 3,
      skippedCount: 3,
      errors: [],
    });
    expect(mockStanding).toHaveBeenCalledTimes(1);
    expect(mockStanding).toHaveBeenCalledWith({
      key: "reconcile-pending-refunds:unknown-at-gateway",
      ids: ["res_a", "res_b", "row_ghost"],
      message: expect.stringContaining("3 PENDING refund(s)"),
    });
    expect(mockPage).toHaveBeenCalledTimes(1);
  });

  test("any other gateway error stays a per-row error and raises no finding", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ id: "res_flaky", ageHours: 30 }),
      ])
      .mockResolvedValueOnce([realIdRow]);
    mockList.mockRejectedValueOnce(
      new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY", {
        statusCode: 502,
      }),
    );
    mockGet.mockRejectedValueOnce(
      new RefundError("Failed to process refund", "UNKNOWN_ERROR", "RAZORPAY"),
    );

    const result = await reconcilePendingRefunds();

    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      "Refund res_flaky: Failed to process refund",
      "Refund row_ghost: Failed to process refund",
    ]);
    expect(result).toMatchObject({ success: false, unknownAtGateway: 0 });
    expect(mockStanding).not.toHaveBeenCalled();
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
    // The poll settles the row, so it decides the seat in the same transaction.
    expect(mockSettleSeat).toHaveBeenCalledWith(
      expect.objectContaining({ refund: refundTable }),
      "row_9",
    );
  });

  test("a polled success takes off again the owed refund the row gave back when it was failed", async () => {
    refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "row_revived",
        refundId: "rfnd_revived",
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
      refundId: "rfnd_revived",
      amount: 10_000,
      currency: "INR",
      status: "SUCCEEDED",
      metadata: undefined,
    });
    const givenBack = {
      settledOwed: {
        key: "owed:pay-9",
        reason: "booking cancelled",
        owedPaise: 10_000,
        settledPaise: 10_000,
        stillOwedPaise: 0,
        note: "settled by hand",
      },
      // What the restore wrote when the refund was failed: ₹100 back on the live marker.
      settledOwedRestored: true,
      settledOwedRestoredPaise: 10_000,
      settledOwedRestoredKey: "owed:pay-9",
    };
    refundTable.findUnique.mockResolvedValue({
      paymentId: "pay-9",
      metadata: givenBack,
      updatedAt: new Date(0),
    });
    // The marker still owes ₹250, of which this refund's ₹100 was given back.
    paymentTable.findUnique.mockResolvedValueOnce({
      refundOwedKey: "owed:pay-9",
      refundOwedPaise: 25_000,
    });

    const result = await reconcilePendingRefunds();

    expect(result.reconciledCount).toBe(1);
    expect(refundTable.updateMany).toHaveBeenCalledWith({
      where: { id: "row_revived", updatedAt: new Date(0) },
      data: { metadata: { ...givenBack, settledOwedResettled: true } },
    });
    // The settled ₹100 comes off the owed refund, by compare-and-set on the marker as read.
    expect(paymentTable.updateMany).toHaveBeenCalledTimes(1);
    expect(paymentTable.updateMany).toHaveBeenCalledWith({
      where: {
        id: "pay-9",
        refundOwedKey: "owed:pay-9",
        refundOwedPaise: 25_000,
      },
      data: { refundOwedPaise: 15_000 },
    });
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
    expect(mockSettleSeat).not.toHaveBeenCalled();
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
        where: { id: "row_failed", status: "FAILED", failedNotifiedAt: null },
      }),
    );
    expect(mockNotifyFailed).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({ amount: 10_000 }),
      expect.objectContaining({
        tx: expect.anything(),
        entityRef: "refund:row_failed",
      }),
    );
  });
});

describe("reconcilePendingRefunds — stranded-refund backstop", () => {
  test("re-drives with credits; a poison row rotates without failing the run", async () => {
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
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("ledger down"));

    const result = await reconcilePendingRefunds();

    expect(reverseCreditsForPayment).toHaveBeenCalledWith(
      "pay_1",
      expect.anything(),
      4_000,
      10_000,
      "ref_stranded",
    );
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

describe("bounded refund polling and durable failure notices", () => {
  test("rotates 25 still-pending refunds through three batches without changing business timestamps", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...placeholderRow({ id: `row_${String(i).padStart(2, "0")}` }),
      refundId: `rfnd_${i}`,
      lastReconciledAt: null as Date | null,
    }));
    refundTable.findMany.mockImplementation(
      async (query: {
        where: { status: string; refundId?: unknown };
        take?: number;
      }) => {
        if (query.where.status !== "PENDING" || query.where.refundId) return [];
        return [...rows]
          .sort(
            (a, b) =>
              (a.lastReconciledAt?.getTime() ?? 0) -
                (b.lastReconciledAt?.getTime() ?? 0) || (a.id < b.id ? -1 : 1),
          )
          .slice(0, query.take);
      },
    );
    const stamp = prisma.$executeRaw as jest.Mock;
    stamp.mockImplementation(async (_sql: TemplateStringsArray, id: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.lastReconciledAt = new Date();
      return 1;
    });
    mockGet.mockResolvedValue({ status: "PENDING" });
    for (let i = 0; i < 3; i++) await reconcilePendingRefunds({ limit: 10 });
    expect(new Set(mockGet.mock.calls.map(([id]) => id)).size).toBe(25);
    expect(refundTable.updateMany).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledTimes(30);
    stamp.mockResolvedValue(1);
  });

  test("a timed-out run leaves unstarted rows available to the next run", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow()])
      .mockResolvedValueOnce([]);
    await reconcilePendingRefunds({ startedAt: Date.now() - 20_000 });
    expect(mockList).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  test("overlapping full and notification runs stage one failure notice even without a job lease", async () => {
    const row = {
      id: "failed_overlap",
      paymentId: "pay_1",
      amountPaise: 1000,
      currency: "INR",
      metadata: {},
      failureReason: null,
      failedAt: null,
      payment: { userId: "user_1", organizationId: null },
    };
    refundTable.findMany.mockImplementation(
      async (q: { where: { status: string } }) =>
        q.where.status === "FAILED" ? [row] : [],
    );
    let claimed = false;
    refundTable.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    await Promise.all([reconcilePendingRefunds(), notifyFailedRefunds()]);
    expect(mockNotifyFailed).toHaveBeenCalledTimes(1);
    expect(stageRefundFailedEmail).toHaveBeenCalledTimes(1);
    expect(stageRefundFailedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refund: refundTable }),
      expect.objectContaining({ paymentId: "pay_1" }),
      null,
    );
    refundTable.updateMany.mockResolvedValue({ count: 1 });
  });
  test("a staging crash rolls back the claim and a new invocation can deliver the notice", async () => {
    const row = {
      id: "failed_crash",
      paymentId: "pay_1",
      amountPaise: 1000,
      currency: "INR",
      metadata: {},
      failureReason: null,
      failedAt: null,
      payment: { userId: "user_1", organizationId: null },
    };
    let claimed = false;
    refundTable.findMany.mockImplementation(async () => (claimed ? [] : [row]));
    refundTable.updateMany.mockImplementation(async () => {
      claimed = true;
      return { count: 1 };
    });
    (prisma.$transaction as jest.Mock).mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        try {
          return await fn({ refund: refundTable });
        } catch (error) {
          claimed = false;
          throw error;
        }
      },
    );
    (stageRefundFailedEmail as jest.Mock).mockRejectedValueOnce(
      new Error("staging interrupted"),
    );
    await expect(notifyFailedRefunds()).rejects.toThrow("staging interrupted");
    expect(claimed).toBe(false);
    await notifyFailedRefunds();
    expect(claimed).toBe(true);
    expect(stageRefundFailedEmail).toHaveBeenCalledTimes(2);
    refundTable.updateMany.mockResolvedValue({ count: 1 });
  });
});

describe("reconcilePendingRefunds — placeholder superseded by a webhook row", () => {
  test("re-points the support recommendation to the winner before deleting the placeholder", async () => {
    const db = prisma as unknown as ReconcilePrismaMock;
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow()])
      .mockResolvedValueOnce([]);
    mockList.mockResolvedValueOnce([
      {
        refundId: "rfnd_won",
        amount: 10_000,
        currency: "INR",
        status: "processed",
        metadata: { reservationId: "res_1" },
      },
    ]);
    db.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    refundTable.findUnique
      .mockResolvedValueOnce({ id: "row_webhook", paymentId: "pay_1" })
      .mockResolvedValueOnce({
        id: "res_1",
        paymentId: "pay_1",
        dedupeKey: null,
        metadata: {},
      });

    const result = await reconcilePendingRefunds();

    expect(result.errors).toEqual([]);
    expect(db.supportFinancialRecommendation.updateMany).toHaveBeenCalledWith({
      where: { refundId: "res_1" },
      data: { refundId: "row_webhook" },
    });
    expect(
      db.supportFinancialRecommendation.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(refundTable.deleteMany.mock.invocationCallOrder[0]);
  });
});

test("notice staging failure preserves completed polling counters and returns an unsuccessful summary", async () => {
  refundTable.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        id: "pending-before-notice",
        refundId: "rfnd_still_pending",
        status: "PENDING",
        amountPaise: 1000,
        createdAt: new Date(Date.now() - 2 * HOUR),
        payment: { paymentGateway: "RAZORPAY" },
      },
    ])
    .mockResolvedValueOnce([
      {
        id: "failed-notice",
        paymentId: "pay_1",
        amountPaise: 1000,
        currency: "INR",
        metadata: {},
        failureReason: null,
        failedAt: null,
        payment: { userId: "user_1", organizationId: null },
      },
    ]);
  mockGet.mockResolvedValueOnce({ status: "PENDING" });
  jest
    .mocked(stageRefundFailedEmail)
    .mockRejectedValueOnce(new Error("notice staging unavailable"));
  const result = await reconcilePendingRefunds();
  expect(result).toMatchObject({
    success: false,
    totalProcessed: 1,
    skippedCount: 1,
  });
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining("notice staging unavailable"),
    ]),
  );
});
