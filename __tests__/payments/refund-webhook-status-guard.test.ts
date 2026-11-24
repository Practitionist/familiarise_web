/**
 * @jest-environment node
 */

/**
 * Refund status state machine in handleRefundCreated (money-hardening pass).
 *
 * The old guard compared the Prisma enum (`SUCCEEDED`) against the RAW gateway
 * string (`"processed"`), so it never short-circuited and every redelivery or
 * out-of-order event rewrote the row: a stale `refund.created` (status
 * "pending") arriving after `refund.processed` downgraded a settled refund to
 * PENDING — manufacturing the unsweepable real-id-PENDING limbo class.
 *
 * Guards under test:
 *   - an event is booked only on a payment that reached SUCCEEDED and only when
 *     it refunds that row's captured gateway payment; anything else books
 *     nothing and records one system event per gateway refund;
 *   - PENDING is the only state a gateway event may leave, except that a late
 *     `refund.processed` settles a FAILED row (the money left after all);
 *   - otherwise SUCCEEDED / FAILED / CANCELLED are terminal (log-and-return);
 *   - PENDING → SUCCEEDED still runs the cascade side effects exactly once.
 *
 * Modeled on dispute-refund-correctness.test.ts's in-memory tx stub.
 */

const recordSystemError = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemEvent = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    recordSystemError: (...args: unknown[]) => recordSystemError(...args),
    recordSystemEvent,
    recordSystemErrorSafe: (...args: unknown[]) => recordSystemError(...args),
    recordSystemEventSafe: recordSystemEvent,
  };
});
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  razorpayClient: { payments: { fetch: jest.fn() } },
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(undefined),
  notifyRefundFailed: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(undefined),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
  walletCredit: jest.fn(),
  walletDebit: jest.fn(),
  WalletInsufficientFundsError: class extends Error {},
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutCompleted: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
  markOrgPayoutReversed: jest.fn(),
  markConsultantPayoutReversed: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
const applyRefundCascade = jest.fn().mockResolvedValue({});
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: (...a: unknown[]) => applyRefundCascade(...a),
  mintInvoiceRefundCreditNote: jest
    .fn()
    .mockResolvedValue({ creditNoteId: null }),
  mintRefundCreditNote: jest.fn(),
  remainingOrgInvoiceCreditPaise: jest.fn().mockResolvedValue(100_000),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue({ created: true }),
}));
const mockStampSeat = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) => mockStampSeat(...a),
}));
const mockIntentInTx = jest.fn(async (..._a: unknown[]) => new Date());
jest.mock("../../lib/stream/revocation-intents", () => ({
  persistRefundRevocationInTx: (...a: unknown[]) => mockIntentInTx(...a),
}));

import prisma from "../../lib/prisma";
import type { PaymentStatus, RefundStatus } from "@prisma/client";
import { recordSystemEvent } from "../../lib/enterprise/system-events";

/** The refund fields the handler reads and the assertions pin. */
interface RefundRow {
  id: string;
  refundId: string;
  status: RefundStatus;
  paymentId: string;
  amountPaise?: number;
  metadata?: Record<string, unknown>;
}

/** The one Payment the stubbed database holds, keyed by both of its ids. */
const PAYMENT_ROW = {
  id: "pay_1",
  paymentIntent: "order_1",
  gatewayPaymentId: "pay_gateway_1" as string | null,
  paymentStatus: "SUCCEEDED" as PaymentStatus,
  userId: "user_1",
  organizationId: null,
  amount: 50_000,
  currency: "INR",
  billingAccountId: null,
};

/** What a hand refund records when it settles an owed refund. */
const SETTLED_OWED = {
  key: "owed:pay_1",
  reason: "booking cancelled",
  owedPaise: 10_000,
  settledPaise: 10_000,
  stillOwedPaise: 0,
  note: "settled by hand",
};

/** A system event as the handler records it. */
interface EventRow {
  severity?: string;
  correlationId?: string | null;
  context?: Record<string, unknown> | null;
}

const store: { refunds: RefundRow[]; events: EventRow[] } = {
  refunds: [],
  events: [],
};

function resetStore() {
  store.refunds = [];
  store.events = [];
  PAYMENT_ROW.gatewayPaymentId = "pay_gateway_1";
  PAYMENT_ROW.paymentStatus = "SUCCEEDED";
}

function txStub() {
  return {
    user: { findMany: jest.fn(async () => []) },
    systemEvent: {
      findFirst: jest.fn(
        async ({ where }: { where: { correlationId: string } }) =>
          store.events.find((e) => e.correlationId === where.correlationId) ??
          null,
      ),
    },
    payment: {
      // #1353 — the handler resolves by EITHER id now, so the stub has to be a
      // real matcher rather than a constant: a test that returns the same row
      // whatever the `where` says cannot tell the two keys apart.
      findFirst: jest.fn(
        async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
          const matches = where.OR.some(
            (clause) =>
              clause.paymentIntent === PAYMENT_ROW.paymentIntent ||
              clause.gatewayPaymentId === PAYMENT_ROW.gatewayPaymentId,
          );
          return matches ? PAYMENT_ROW : null;
        },
      ),
    },
    creditNote: {
      findUnique: jest.fn(async () => null),
      aggregate: jest.fn(async () => ({ _sum: { totalPaise: null } })),
    },
    walletTopUp: { findFirst: jest.fn(async () => null) },
    organizationInvoice: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    ledgerTransaction: { findUnique: jest.fn(async () => null) },
    billingAccount: {
      findFirst: jest.fn(async () => null),
      findUniqueOrThrow: jest.fn(),
    },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    refund: {
      // By gateway id for the handler; by row id, with its payment, for the seat settle.
      findUnique: jest.fn(
        async ({ where }: { where: { refundId?: string; id?: string } }) => {
          if (where.refundId)
            return (
              store.refunds.find((r) => r.refundId === where.refundId) ?? null
            );
          const row = store.refunds.find((r) => r.id === where.id);
          return row
            ? {
                ...row,
                payment: {
                  amount: PAYMENT_ROW.amount,
                  userId: PAYMENT_ROW.userId,
                  refunds: store.refunds.map((r) => ({
                    amountPaise: r.amountPaise ?? 0,
                    status: r.status,
                  })),
                  disputes: [],
                },
              }
            : null;
        },
      ),
      // The reservation a refund's notes name, while it still holds its placeholder id.
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; amountPaise: number } }) =>
          store.refunds.find(
            (r) =>
              r.id === where.id &&
              r.amountPaise === where.amountPaise &&
              r.refundId.startsWith("pending_"),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<RefundRow, "id"> }) => {
        const created: RefundRow = {
          id: `row_${store.refunds.length + 1}`,
          ...data,
        };
        store.refunds.push(created);
        return created;
      }),
      update: jest.fn(async ({ data }: { data: Partial<RefundRow> }) => {
        const row = store.refunds[0];
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: RefundStatus };
          data: Partial<RefundRow>;
        }) => {
          const row = store.refunds.find(
            (r) =>
              r.id === where.id &&
              (where.status === undefined || r.status === where.status),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
  };
}

type TxStub = ReturnType<typeof txStub>;

// Single typed seam over the real client: the handler's $transaction callback
// runs against our stub (env-backed prisma import, same trick as before —
// the double cast is confined to this one assignment).
type TransactionFn = (
  fn: (tx: TxStub) => Promise<unknown>,
  opts?: unknown,
) => Promise<unknown>;
(prisma as unknown as { $transaction: TransactionFn }).$transaction = (fn) =>
  fn(txStub());

import { DeferSignal, handleRefundCreated } from "../../app/api/webhooks/utils";
import { walletCredit } from "../../lib/api/organizations/wallet";

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  applyRefundCascade.mockClear().mockResolvedValue({});
  jest.mocked(recordSystemEvent).mockImplementation(async (event) => {
    store.events.push(event);
  });
});

describe("a refund event is applied only to the payment that was captured", () => {
  const deliver = (
    over: {
      status?: string;
      eventPaymentId?: string;
      captured?: boolean;
    } = {},
  ) =>
    handleRefundCreated(
      "rfnd_evt",
      "order_1",
      10_000,
      "INR",
      over.status ?? "processed",
      over.eventPaymentId ?? "pay_gateway_1",
      undefined,
      over.captured,
    );

  const bookedNothing = () => {
    expect(store.refunds).toHaveLength(0);
    expect(applyRefundCascade).not.toHaveBeenCalled();
  };

  test("a refund of another attempt on the same order books nothing and records one event across deliveries", async () => {
    await deliver({ status: "created", eventPaymentId: "pay_other_attempt" });
    await deliver({ eventPaymentId: "pay_other_attempt" });

    bookedNothing();
    expect(store.events).toEqual([
      expect.objectContaining({
        severity: "ERROR",
        correlationId: "refund-unmatched:rfnd_evt",
        context: expect.objectContaining({
          gatewayRefundId: "rfnd_evt",
          orderId: "order_1",
          gatewayPaymentId: "pay_other_attempt",
          capturedGatewayPaymentId: "pay_gateway_1",
          reason: expect.stringContaining("not the captured payment"),
        }),
      }),
    ]);
  });

  test.each(["EXPIRED", "FAILED"] as const)(
    "a refund on a %s row books nothing, even when the row holds the refunded attempt's id",
    async (paymentStatus) => {
      PAYMENT_ROW.paymentStatus = paymentStatus;
      PAYMENT_ROW.gatewayPaymentId = "pay_failed_attempt";

      await deliver({ eventPaymentId: "pay_failed_attempt" });

      bookedNothing();
      expect(store.events).toEqual([
        expect.objectContaining({
          severity: "WARN",
          context: expect.objectContaining({
            orderId: "order_1",
            paymentStatus,
            reason: expect.stringContaining("never captured"),
          }),
        }),
      ]);
    },
  );

  test("an embedded captured:false is decisive, whatever the row says", async () => {
    await deliver({ captured: false });
    PAYMENT_ROW.paymentStatus = "PENDING";
    const pending = await handleRefundCreated(
      "rfnd_evt_2",
      "order_1",
      10_000,
      "INR",
      "processed",
      "pay_gateway_1",
      undefined,
      false,
    );

    bookedNothing();
    expect(pending).toBeUndefined();
    expect(store.events.map((e) => e.correlationId)).toEqual([
      "refund-unmatched:rfnd_evt",
      "refund-unmatched:rfnd_evt_2",
    ]);
  });

  test("a PENDING row without that flag defers, so the capture can land first", async () => {
    PAYMENT_ROW.paymentStatus = "PENDING";

    const result = await deliver();

    expect(result).toBeInstanceOf(DeferSignal);
    bookedNothing();
    expect(store.events).toHaveLength(0);
  });

  test("the captured payment's refund is booked, and so is one on a row with no stored capture id", async () => {
    await deliver({ captured: true });
    PAYMENT_ROW.gatewayPaymentId = null;
    await handleRefundCreated(
      "rfnd_evt_3",
      "order_1",
      5_000,
      "INR",
      "processed",
      "pay_any",
    );

    expect(store.refunds.map((r) => [r.refundId, r.status])).toEqual([
      ["rfnd_evt", "SUCCEEDED"],
      ["rfnd_evt_3", "SUCCEEDED"],
    ]);
    expect(applyRefundCascade).toHaveBeenCalledTimes(2);
    expect(store.events).toHaveLength(0);
  });
});

describe("handleRefundCreated status transition guard", () => {
  test("a stale refund.created does NOT downgrade a SUCCEEDED refund", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "SUCCEEDED",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      10_000,
      "INR",
      "pending", // raw gateway string from a late/out-of-order refund.created
    );

    // No update may run at all — the row must stay settled.
    expect(store.refunds[0].status).toBe("SUCCEEDED");
    // And the cascade must not re-run.
    expect(applyRefundCascade).not.toHaveBeenCalled();
  });

  test("a late refund.processed settles a FAILED refund and cascades exactly once", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "FAILED",
      paymentId: "pay_1",
    });

    await handleRefundCreated("rfnd_1", "order_1", 10_000, "INR", "processed");
    await handleRefundCreated("rfnd_1", "order_1", 10_000, "INR", "processed");

    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  test("a late refund.processed claims the FAILED placeholder its notes name instead of booking a second row", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "pending_row_1",
      status: "FAILED",
      paymentId: "pay_1",
      amountPaise: 10_000,
      // A hand refund whose settled owed amount was given back when it failed.
      metadata: {
        settledOwed: SETTLED_OWED,
        settledOwedRestored: true,
      },
    });

    await handleRefundCreated(
      "rfnd_late",
      "order_1",
      10_000,
      "INR",
      "processed",
      "pay_gateway_1",
      { reservationId: "row_1" },
    );

    expect(store.refunds).toEqual([
      expect.objectContaining({
        id: "row_1",
        refundId: "rfnd_late",
        status: "SUCCEEDED",
        // The late success takes the given-back owed refund off again, once.
        metadata: expect.objectContaining({ settledOwedResettled: true }),
      }),
    ]);
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  test("a stale refund.created cannot reopen a FAILED refund", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "FAILED",
      paymentId: "pay_1",
    });

    await handleRefundCreated("rfnd_1", "order_1", 10_000, "INR", "pending");

    expect(store.refunds[0].status).toBe("FAILED");
    expect(applyRefundCascade).not.toHaveBeenCalled();
  });

  test("PENDING → processed maps the enum, settles, and cascades once", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated("rfnd_1", "order_1", 10_000, "INR", "processed");

    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  // #1353 — the pin for the lookup change. Razorpay's refund webhook carries
  // only the `pay_…` payment id, and when the dispatcher's `payments.fetch`
  // translation failed it handed that id through as `paymentIntentId`. A lookup
  // keyed solely on `Payment.paymentIntent` (which holds the ORDER id) could
  // never match it, so the handler deferred and the sweeper re-drove the event
  // for up to a week against a payment that had been captured all along.
  test("a refund whose paymentIntentId is a pay_ id resolves via gatewayPaymentId", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      // Not an order id — exactly what the dispatcher passes through when the
      // gateway translation is unavailable.
      "pay_gateway_1",
      10_000,
      "INR",
      "processed",
      "pay_gateway_1",
    );

    // Resolved, settled and cascaded — not deferred.
    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
  });

  test("same-status redelivery of a PENDING refund is a no-op", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated("rfnd_1", "order_1", 10_000, "INR", "pending");

    expect(applyRefundCascade).not.toHaveBeenCalled();
    expect(store.refunds).toHaveLength(1);
  });
});

describe("a booking refund's seat is decided as its webhook settles it", () => {
  const fullRefundIntent = {
    seatIntent: {
      keepSeat: false,
      keepSeatIfPartial: false,
    },
  };

  test("a reservation left PENDING by a gateway timeout ends its seat in the webhook's transaction", async () => {
    // The ₹500 refund reached Razorpay, but the HTTP call timed out: the row kept its placeholder id.
    store.refunds.push({
      id: "row_1",
      refundId: "pending_row_1",
      status: "PENDING",
      paymentId: "pay_1",
      amountPaise: 50_000,
      metadata: { source: "app", ...fullRefundIntent },
    });
    const used: TxStub[] = [];
    (prisma as unknown as { $transaction: TransactionFn }).$transaction = (
      fn,
    ) => {
      const tx = txStub();
      used.push(tx);
      return fn(tx);
    };

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      50_000,
      "INR",
      "processed",
      undefined,
      { reservationId: "row_1" },
    );

    expect(store.refunds[0]).toMatchObject({
      refundId: "rfnd_1",
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: true }),
    });
    expect(mockStampSeat).toHaveBeenCalledWith(
      used[0],
      { paymentId: "pay_1" },
      "REFUNDED",
      { history: { reason: "refunded", actorUserId: null } },
    );
    expect(mockIntentInTx).toHaveBeenCalledWith(used[0], {
      refundId: "row_1",
      payerUserId: "user_1",
    });
  });

  test("a dashboard refund with no stored intent leaves the seat alone", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
      amountPaise: 50_000,
    });

    await handleRefundCreated("rfnd_1", "order_1", 50_000, "INR", "processed");

    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(mockStampSeat).not.toHaveBeenCalled();
    expect(mockIntentInTx).not.toHaveBeenCalled();
  });
});

// #1128 (owner decision Q7) — the invoice-refund block used to swallow a
// failed journal / wallet credit, committing the credit note with no money
// truth behind it and nothing for a sweep to find.
describe("an invoice refund whose wallet credit fails aborts the transaction", () => {
  test("a throwing walletCredit propagates so the tx rolls back — no committed CN", async () => {
    const tx = txStub();
    tx.organizationInvoice.findFirst.mockResolvedValue({
      id: "inv_1",
      organizationId: "org_1",
      invoiceNumber: "INV-1",
      totalPaise: 100_000,
      status: "PAID",
    } as never);
    tx.billingAccount.findFirst.mockResolvedValue({
      id: "ba_1",
      fundingSource: "WALLET",
    } as never);
    (walletCredit as jest.Mock).mockRejectedValueOnce(
      new Error("wallet cache write failed"),
    );
    let committed = false;
    (prisma as unknown as { $transaction: TransactionFn }).$transaction =
      async (fn) => {
        const result = await fn(tx);
        committed = true;
        return result;
      };

    await expect(
      handleRefundCreated(
        "rfnd_inv_1",
        "order_unknown",
        10_000,
        "INR",
        "processed",
        "pay_inv_1",
      ),
    ).rejects.toThrow("wallet cache write failed");

    // The callback threw before the transaction could commit the CN.
    expect(committed).toBe(false);
  });
});
