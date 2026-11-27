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
const mockBookTopUpRefund = jest.fn(async (..._a: unknown[]) => ({
  booked: true,
  clawbackPaise: 5_000,
  shortfallPaise: 0,
}));
jest.mock("../../lib/payments/operations/wallet-refund", () => ({
  bookTopUpRefund: (...a: unknown[]) => mockBookTopUpRefund(...a),
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

/** A failed hand refund's metadata after its settled ₹100 went back onto the live marker. */
const GIVEN_BACK = {
  settledOwed: SETTLED_OWED,
  settledOwedRestored: true,
  settledOwedRestoredPaise: 10_000,
  settledOwedRestoredKey: "owed:pay_1",
};

/** A system event as the handler records it. */
interface EventRow {
  severity?: string;
  correlationId?: string | null;
  context?: Record<string, unknown> | null;
}

/** The payment's owed-refund marker columns. */
type OwedMarker = Record<string, unknown> & {
  refundOwedKey: string | null;
  refundOwedPaise: number | null;
};

const store: { refunds: RefundRow[]; events: EventRow[]; marker: OwedMarker } =
  {
    refunds: [],
    events: [],
    marker: { refundOwedKey: null, refundOwedPaise: null },
  };

function resetStore() {
  store.refunds = [];
  store.events = [];
  store.marker = { refundOwedKey: null, refundOwedPaise: null };
  PAYMENT_ROW.gatewayPaymentId = "pay_gateway_1";
  PAYMENT_ROW.paymentStatus = "SUCCEEDED";
}

const mockMoveMarker = jest.fn(
  async ({ where, data }: { where: OwedMarker; data: Partial<OwedMarker> }) => {
    if (
      where.refundOwedKey !== store.marker.refundOwedKey ||
      where.refundOwedPaise !== store.marker.refundOwedPaise
    ) {
      return { count: 0 };
    }
    Object.assign(store.marker, data);
    return { count: 1 };
  },
);

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
      // The owed-refund marker, read and moved by compare-and-set on what was read.
      findUnique: jest.fn(async () => ({ ...store.marker })),
      updateMany: mockMoveMarker,
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
          where: { id: string; status?: RefundStatus; refundId?: string };
          data: Partial<RefundRow>;
        }) => {
          const row = store.refunds.find(
            (r) =>
              r.id === where.id &&
              (where.status === undefined || r.status === where.status) &&
              (where.refundId === undefined || r.refundId === where.refundId),
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
import { postLedgerTxn } from "../../lib/payments/ledger/post";

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
      // A hand refund whose settled ₹100 was given back to the marker when it failed.
      metadata: GIVEN_BACK,
    });
    // The marker owes exactly what was given back.
    store.marker = { refundOwedKey: "owed:pay_1", refundOwedPaise: 10_000 };
    const deliver = () =>
      handleRefundCreated(
        "rfnd_late",
        "order_1",
        10_000,
        "INR",
        "processed",
        "pay_gateway_1",
        { reservationId: "row_1" },
      );

    await deliver();
    await deliver();

    expect(store.refunds).toEqual([
      expect.objectContaining({
        id: "row_1",
        refundId: "rfnd_late",
        status: "SUCCEEDED",
        metadata: expect.objectContaining({ settledOwedResettled: true }),
      }),
    ]);
    // The late success clears the marker it had refilled, once; the replay moves nothing.
    expect(store.marker).toMatchObject({
      refundOwedKey: null,
      refundOwedPaise: null,
    });
    expect(mockMoveMarker).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  test("a pending event for a FAILED placeholder returns that row to PENDING under the gateway id, and the later success settles it", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "pending_row_1",
      status: "FAILED",
      paymentId: "pay_1",
      amountPaise: 10_000,
      metadata: GIVEN_BACK,
    });
    // The marker owes ₹250, of which this refund's ₹100 was given back.
    store.marker = { refundOwedKey: "owed:pay_1", refundOwedPaise: 25_000 };
    const deliver = (status: string) =>
      handleRefundCreated(
        "rfnd_late",
        "order_1",
        10_000,
        "INR",
        status,
        "pay_gateway_1",
        { reservationId: "row_1" },
      );

    await deliver("pending");

    expect(store.refunds).toEqual([
      expect.objectContaining({
        id: "row_1",
        refundId: "rfnd_late",
        status: "PENDING",
      }),
    ]);
    expect(applyRefundCascade).not.toHaveBeenCalled();
    // Still in flight: the owed refund is untouched.
    expect(store.marker.refundOwedPaise).toBe(25_000);

    await deliver("processed");
    await deliver("processed");

    // The success takes the ₹100 off, once; the replay moves nothing.
    expect(store.marker).toEqual({
      refundOwedKey: "owed:pay_1",
      refundOwedPaise: 15_000,
    });
    expect(mockMoveMarker).toHaveBeenCalledTimes(1);

    expect(store.refunds).toEqual([
      expect.objectContaining({
        id: "row_1",
        refundId: "rfnd_late",
        status: "SUCCEEDED",
        metadata: expect.objectContaining({ settledOwedResettled: true }),
      }),
    ]);
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  test("a pending event never rebinds a FAILED reservation that already holds another gateway refund id", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_first",
      status: "FAILED",
      paymentId: "pay_1",
      amountPaise: 10_000,
    });

    await handleRefundCreated(
      "rfnd_other",
      "order_1",
      10_000,
      "INR",
      "pending",
      "pay_gateway_1",
      { reservationId: "row_1" },
    );

    expect(store.refunds[0]).toEqual({
      id: "row_1",
      refundId: "rfnd_first",
      status: "FAILED",
      paymentId: "pay_1",
      amountPaise: 10_000,
    });
    expect(applyRefundCascade).not.toHaveBeenCalled();
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

describe("a refund event that says its payment was never captured books nothing on the enterprise rails either", () => {
  const TOP_UP = {
    id: "tu_1",
    billingAccountId: "ba_1",
    amountPaise: 5_000,
    providerOrderId: "order_tu",
  };
  const INVOICE = {
    id: "inv_1",
    organizationId: "org_1",
    invoiceNumber: "INV-1",
    subtotalPaise: 5_000,
    totalPaise: 5_000,
    status: "PAID",
  };
  /** One delivery for a payment no Payment row holds, against the rows given. */
  async function deliver(
    rows: { topUp?: typeof TOP_UP; invoice?: typeof INVOICE },
    captured: boolean | undefined,
  ) {
    const tx = txStub();
    tx.walletTopUp.findFirst.mockResolvedValue((rows.topUp ?? null) as never);
    tx.organizationInvoice.findFirst.mockResolvedValue(
      (rows.invoice ?? null) as never,
    );
    (prisma as unknown as { $transaction: TransactionFn }).$transaction = (
      fn,
    ) => fn(tx);
    const result = await handleRefundCreated(
      "rfnd_ent",
      "order_unknown",
      5_000,
      "INR",
      "processed",
      "pay_ent",
      undefined,
      captured,
    );
    return { tx, result };
  }

  test.each([
    ["a confirmed wallet top-up", { topUp: TOP_UP }],
    ["a paid organisation invoice", { invoice: INVOICE }],
    ["no row at all", {}],
  ])("captured:false against %s", async (_label, rows) => {
    const { tx, result } = await deliver(rows, false);

    expect(result).toBeUndefined();
    expect(mockBookTopUpRefund).not.toHaveBeenCalled();
    expect(postLedgerTxn).not.toHaveBeenCalled();
    expect(tx.orgAuditLog.create).not.toHaveBeenCalled();
    expect(store.events).toEqual([
      expect.objectContaining({
        severity: "WARN",
        correlationId: "refund-unmatched:rfnd_ent",
        context: expect.objectContaining({
          gatewayRefundId: "rfnd_ent",
          orderId: "order_unknown",
          gatewayPaymentId: "pay_ent",
          reason: expect.stringContaining("never captured"),
        }),
      }),
    ]);
  });

  test("a top-up refund whose event carries no flag is booked as before", async () => {
    await deliver({ topUp: TOP_UP }, undefined);

    expect(mockBookTopUpRefund).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveLength(0);
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
