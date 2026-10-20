/**
 * @jest-environment node
 */

/**
 * Signed Razorpay deliveries replayed through the real route, the real
 * event-log dedupe, the real dispatch switch and the real handlers, over one
 * in-memory world. Each scenario ends on the single effect it must leave:
 * duplicates, out-of-order arrival and delayed arrival never act twice.
 */

import crypto from "node:crypto";
import {
  disputeApi,
  earning,
  holdStore,
  paymentApi,
  world,
  type Row,
} from "../fixtures/razorpay-webhook-world";

const afterCallbacks: Array<() => unknown> = [];
jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  getCurrentScope: () => ({ setTag: jest.fn() }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fmt: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, s, i) => acc + s + String(values[i] ?? ""), ""),
  },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual<
    typeof import("../fixtures/razorpay-webhook-world")
  >("../fixtures/razorpay-webhook-world").prismaStub,
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const refundBookingPayment = jest.fn(async () => ({ status: "SUCCEEDED" }));
const applyRefundCascade = jest.fn(async () => undefined);
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(async () => ({ status: "SUCCEEDED" })),
  applyRefundCascade: (...a: unknown[]) =>
    (applyRefundCascade as (...x: unknown[]) => unknown)(...a),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn(),
  remainingOrgInvoiceCreditPaise: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) =>
    (refundBookingPayment as (...x: unknown[]) => unknown)(...a),
}));

const postUnappliedReceipt = jest.fn();
jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  postUnappliedReceipt: (...a: unknown[]) => postUnappliedReceipt(...a),
  releaseUnappliedReceipt: jest.fn(),
}));
const postGatewayFee = jest.fn();
jest.mock("../../lib/payments/ledger/gateway-fee", () => ({
  postGatewayFee: (...a: unknown[]) => postGatewayFee(...a),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(async () => ({ id: "ltxn", created: true })),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => null,
  withRazorpaySdkTimeout: (_op: string, call: () => unknown) => call(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/payout-service", () => ({
  reportUnknownPayoutStatus: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/reverse-penny-drop", () => ({
  handleFundAccountValidationWebhook: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  releaseClawbackRecovery: jest.fn(),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: jest.fn(),
  mintConsumerCreditNote: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: jest.fn(),
  handleRecordingPurchaseFailure: jest.fn(),
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
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
  attemptTrigger: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { WEBHOOK: 1000 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "refund", DISPUTE_NOTICE: "dispute" },
  stageRefundProcessedEmail: jest.fn(async () => []),
  attempt: jest.fn(),
  attemptStaged: jest.fn(),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/senders/money", () => ({
  sendOrgBillingEmail: jest.fn(),
  stageDisputeNoticeEmail: jest.fn(async () => []),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/webhooks/razorpay/route";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";
import { razorpayWebhookEnvelopeSchema } from "../../schemas/webhooks/razorpay";

const SECRET = "whsec_replay_matrix";
const ORDER = "order_ABC";
const PAY = "pay_XYZ";
const AMOUNT = 50_000;

async function flushAfter() {
  for (const cb of afterCallbacks.splice(0)) await cb();
}

let eventSeq = 0;
function deliver(
  body: object,
  opts: { eventId?: string | null; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-razorpay-signature": crypto
      .createHmac("sha256", opts.secret ?? SECRET)
      .update(raw)
      .digest("hex"),
  };
  if (opts.eventId !== null) {
    headers["x-razorpay-event-id"] = opts.eventId ?? `evt_${++eventSeq}`;
  }
  return POST(
    new NextRequest("https://x.test/api/webhooks/razorpay", {
      method: "POST",
      headers,
      body: raw,
    }),
  );
}

/** The gateway's outer envelope, with the fields the dispatch schema requires. */
function envelope<T extends object>(
  event: string,
  payload: T,
): { event: string; payload: T } & Record<string, unknown> {
  return {
    entity: "event",
    account_id: "acc_test",
    event,
    contains: Object.keys(payload),
    payload,
    created_at: 1_790_000_000,
  };
}

const paymentEntity = {
  fee: 1180,
  tax: 180,
  id: PAY,
  amount: AMOUNT,
  currency: "INR",
  status: "captured",
  order_id: ORDER,
  notes: { appointmentType: "CONSULTATION" },
};
const capturedEvent = () =>
  envelope("payment.captured", { payment: { entity: paymentEntity } });
const orderPaidEvent = () =>
  envelope("order.paid", {
    order: {
      entity: {
        id: ORDER,
        amount: AMOUNT,
        currency: "INR",
        status: "paid",
        notes: { appointmentType: "CONSULTATION" },
      },
    },
    payment: { entity: paymentEntity },
  });
const refundProcessedEvent = () =>
  envelope("refund.processed", {
    payment: { entity: { ...paymentEntity } },
    refund: {
      entity: {
        id: "rfnd_1",
        payment_id: PAY,
        amount: 20_000,
        currency: "INR",
        status: "processed",
        notes: {},
      },
    },
  });
const disputeEvent = (suffix: "created" | "won", status: string) =>
  envelope(`payment.dispute.${suffix}`, {
    dispute: {
      entity: {
        id: "disp_1",
        payment_id: PAY,
        amount: AMOUNT,
        currency: "INR",
        status,
        reason_code: "fraud",
        respond_by: 1_900_000_000,
      },
    },
  });

function seedPayment(over: Row = {}) {
  world.payments.set("pay-row-1", {
    id: "pay-row-1",
    userId: "u-1",
    paymentIntent: ORDER,
    gatewayPaymentId: null,
    amount: AMOUNT,
    currency: "INR",
    paymentStatus: "PENDING",
    appointmentId: null,
    organizationId: null,
    description: null,
    ...over,
  });
}
const payment = () => world.payments.get("pay-row-1") as Row;
const eventRows = (type: string) =>
  [...world.events.values()].filter((e) => e.eventType === type);

beforeEach(() => {
  jest.clearAllMocks();
  afterCallbacks.length = 0;
  eventSeq = 0;
  world.events.clear();
  world.payments.clear();
  world.refunds.length = 0;
  world.disputes.length = 0;
  world.transactions = 0;
  holdStore.consultant.length = 0;
  holdStore.org.length = 0;
  holdStore.holds.length = 0;
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });
  if (!process.env.DBG) jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  if (!process.env.DBG)
    jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("signature gate", () => {
  it("rejects a delivery signed with the wrong secret before it touches the event log", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });
    const res = await deliver(capturedEvent(), { secret: "not-the-secret" });
    expect(res.status).toBe(400);
    expect(world.events.size).toBe(0);
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("duplicate delivery of the same x-razorpay-event-id", () => {
  it("a retry after the first delivery settled is acknowledged and acts on nothing", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    const first = await deliver(capturedEvent(), { eventId: "evt_dup" });
    expect(await first.json()).toEqual({ status: "ok" });
    await flushAfter();

    const second = await deliver(capturedEvent(), { eventId: "evt_dup" });
    expect(await second.json()).toEqual({ status: "ok", duplicate: true });
    await flushAfter();

    expect(afterCallbacks).toHaveLength(0);
    expect(eventRows("payment.captured")).toHaveLength(1);
    // One CAS claim on the EXPIRED row, one parked receipt, one refund.
    expect(
      paymentApi.updateMany.mock.calls.filter(
        ([a]) => (a.data as Row).paymentStatus === "SUCCEEDED",
      ),
    ).toHaveLength(1);
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(postGatewayFee).toHaveBeenCalledTimes(1);
    expect(eventRows("payment.captured")[0]).toMatchObject({
      processed: true,
      error: null,
    });
  });

  it("a redelivery that lands while the first is still in flight is dropped, not run concurrently", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    const [a, b] = await Promise.all([
      deliver(capturedEvent(), { eventId: "evt_inflight" }),
      deliver(capturedEvent(), { eventId: "evt_inflight" }),
    ]);
    const bodies = await Promise.all([a.json(), b.json()]);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { status: "ok" },
        { status: "ok", duplicate: true },
      ]),
    );

    expect(afterCallbacks).toHaveLength(1);
    await flushAfter();

    expect(eventRows("payment.captured")).toHaveLength(1);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
  });

  it("a retry long after the first settled, past any in-flight lease, is still a duplicate", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    await deliver(capturedEvent(), { eventId: "evt_late_retry" });
    await flushAfter();
    const aged = new Date(Date.now() - 60 * 60_000);
    const row = eventRows("payment.captured")[0];
    row.claimedAt = aged;
    row.receivedAt = aged;

    const again = await deliver(capturedEvent(), { eventId: "evt_late_retry" });

    expect(await again.json()).toEqual({ status: "ok", duplicate: true });
    expect(afterCallbacks).toHaveLength(0);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("a delivery without an event-id header dedupes on the body hash", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    await deliver(capturedEvent(), { eventId: null });
    await flushAfter();
    const again = await deliver(capturedEvent(), { eventId: null });

    expect(await again.json()).toEqual({ status: "ok", duplicate: true });
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("a delivery whose processing failed is re-claimed once by the retry, then settles", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });
    paymentApi.findUnique.mockRejectedValueOnce(new Error("db blip"));

    await deliver(capturedEvent(), { eventId: "evt_retry" });
    await flushAfter();
    expect(eventRows("payment.captured")[0].error).toBe("db blip");

    const retry = await deliver(capturedEvent(), { eventId: "evt_retry" });
    expect(await retry.json()).toEqual({ status: "ok" });
    await flushAfter();
    const third = await deliver(capturedEvent(), { eventId: "evt_retry" });
    expect(await third.json()).toEqual({ status: "ok", duplicate: true });

    expect(eventRows("payment.captured")[0]).toMatchObject({
      processed: true,
      error: null,
    });
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });
});

describe("out-of-order delivery", () => {
  it("payment.captured after order.paid: the second event finds the payment settled and does nothing", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    await deliver(orderPaidEvent());
    await flushAfter();
    expect(payment()).toMatchObject({
      paymentStatus: "SUCCEEDED",
      gatewayPaymentId: PAY,
    });
    const transactionsAfterFirst = world.transactions;

    await deliver(capturedEvent());
    await flushAfter();

    // The second event is a different delivery of the same capture: the
    // already-confirmed fast path answers it without a transaction.
    expect(world.transactions).toBe(transactionsAfterFirst);
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(
      paymentApi.updateMany.mock.calls.filter(
        ([a]) => (a.data as Row).paymentStatus === "SUCCEEDED",
      ),
    ).toHaveLength(1);
    expect(eventRows("order.paid")[0]).toMatchObject({ processed: true });
    expect(eventRows("payment.captured")[0]).toMatchObject({ processed: true });
  });

  it("payment.captured after the client return already confirmed it: the gateway id is backfilled once, never re-confirmed", async () => {
    seedPayment({ paymentStatus: "SUCCEEDED", appointmentId: "appt-1" });

    await deliver(orderPaidEvent());
    await deliver(capturedEvent());
    await flushAfter();

    expect(world.transactions).toBe(0);
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(postUnappliedReceipt).not.toHaveBeenCalled();
    expect(paymentApi.updateMany).toHaveBeenCalledTimes(1);
    expect(paymentApi.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-row-1", gatewayPaymentId: null },
      data: { gatewayPaymentId: PAY },
    });
    expect(payment()).toMatchObject({
      paymentStatus: "SUCCEEDED",
      gatewayPaymentId: PAY,
      appointmentId: "appt-1",
    });
  });

  it("refund.processed before payment.captured defers, leaves the event re-drivable, and the re-drive refunds exactly once", async () => {
    seedPayment({ paymentStatus: "PENDING" });

    await deliver(refundProcessedEvent(), { eventId: "evt_refund" });
    await flushAfter();

    expect(world.refunds).toHaveLength(0);
    expect(applyRefundCascade).not.toHaveBeenCalled();
    expect(eventRows("refund.processed")[0]).toMatchObject({
      processed: false,
      error: null,
      deferCount: 1,
    });

    // The capture lands (another delivery or the verify path), then the sweeper re-drives.
    payment().paymentStatus = "SUCCEEDED";
    const row = eventRows("refund.processed")[0];
    const envelope = razorpayWebhookEnvelopeSchema.parse(
      refundProcessedEvent(),
    );
    await processRazorpayWebhookEvent(
      envelope,
      "refund.processed",
      String(row.eventId),
    );

    expect(world.refunds).toHaveLength(1);
    expect(world.refunds[0]).toMatchObject({
      refundId: "rfnd_1",
      amountPaise: 20_000,
      status: "SUCCEEDED",
      paymentId: "pay-row-1",
    });
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(eventRows("refund.processed")[0]).toMatchObject({
      processed: true,
      error: null,
    });

    // Razorpay's own retry of the same event and a second sweep both act on nothing.
    const retry = await deliver(refundProcessedEvent(), {
      eventId: "evt_refund",
    });
    expect(await retry.json()).toEqual({ status: "ok", duplicate: true });
    await processRazorpayWebhookEvent(
      envelope,
      "refund.processed",
      String(row.eventId),
    );
    expect(world.refunds).toHaveLength(1);
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
  });

  it("payment.dispute.won before payment.dispute.created defers; created then holds the earning once and the re-driven win releases it", async () => {
    seedPayment({ paymentStatus: "SUCCEEDED", gatewayPaymentId: PAY });
    holdStore.consultant.push(earning("ce-1"));

    await deliver(disputeEvent("won", "won"), { eventId: "evt_won" });
    await flushAfter();

    expect(world.disputes).toHaveLength(0);
    expect(holdStore.holds).toHaveLength(0);
    expect(eventRows("payment.dispute.won")[0]).toMatchObject({
      processed: false,
      error: null,
      deferCount: 1,
    });

    await deliver(disputeEvent("created", "open"), { eventId: "evt_created" });
    await flushAfter();

    expect(world.disputes).toHaveLength(1);
    expect(world.disputes[0]).toMatchObject({
      disputeId: "disp_1",
      status: "NEEDS_RESPONSE",
    });
    expect(holdStore.consultant[0].status).toBe("HELD");
    expect(holdStore.holds).toHaveLength(1);

    const row = eventRows("payment.dispute.won")[0];
    const envelope = razorpayWebhookEnvelopeSchema.parse(
      disputeEvent("won", "won"),
    );
    await processRazorpayWebhookEvent(
      envelope,
      "payment.dispute.won",
      String(row.eventId),
    );

    expect(world.disputes[0].status).toBe("WON");
    expect(disputeApi.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "dsp-row-1", status: "NEEDS_RESPONSE" },
      }),
    );
    expect(holdStore.consultant[0].status).toBe("READY");
    expect(holdStore.activeReasons("ce-1")).toEqual([]);

    // A second re-drive of a terminal dispute is a legal-transition no-op.
    const updatesBefore = disputeApi.updateMany.mock.calls.length;
    await processRazorpayWebhookEvent(
      envelope,
      "payment.dispute.won",
      String(row.eventId),
    );
    expect(disputeApi.updateMany.mock.calls.length).toBe(updatesBefore);
    expect(world.disputes).toHaveLength(1);
    expect(holdStore.holds).toHaveLength(1);
  });
});

describe("delayed delivery", () => {
  it("a capture arriving after the expiry sweep is claimed by CAS on EXPIRED, parked and refunded, never booked", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    await deliver(capturedEvent());
    await flushAfter();

    expect(paymentApi.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-row-1", paymentStatus: "EXPIRED" },
      data: expect.objectContaining({
        paymentStatus: "SUCCEEDED",
        gatewayPaymentId: PAY,
        description: expect.stringMatching(/^Auto-refund pending:/),
      }),
    });
    expect(postUnappliedReceipt).toHaveBeenCalledWith(expect.anything(), {
      paymentId: "pay-row-1",
      capturedPaise: AMOUNT,
    });
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-row-1", amountPaise: AMOUNT }),
    );
    expect(payment().description).toMatch(/^Auto-refunded:/);
  });

  it("the same late capture delivered again by a different event id does not refund twice", async () => {
    seedPayment({ paymentStatus: "EXPIRED" });

    await deliver(capturedEvent());
    await flushAfter();
    await deliver(capturedEvent());
    await flushAfter();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
  });

  it("a capture arriving after the client verify confirmed the booking changes nothing but the gateway id", async () => {
    seedPayment({
      paymentStatus: "SUCCEEDED",
      appointmentId: "appt-1",
      gatewayPaymentId: PAY,
    });

    await deliver(capturedEvent());
    await flushAfter();

    expect(world.transactions).toBe(0);
    expect(paymentApi.updateMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(eventRows("payment.captured")[0]).toMatchObject({
      processed: true,
      error: null,
    });
  });
});
