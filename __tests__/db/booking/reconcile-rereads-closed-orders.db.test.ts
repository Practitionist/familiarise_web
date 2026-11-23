/**
 * `reconcile-payment-status` re-reads orders we closed in the last 72 hours, on real Postgres:
 *  - a capture found on an order the expiry sweep closed is refunded once and confirms nothing;
 *  - a later webhook for the same capture refunds nothing more;
 *  - a refund already made at the gateway is recorded, and only the rest is refunded;
 *  - an order gets one more read after its 72 hours, and none after that or past the grace;
 *  - a pre-mint placeholder is never read, and an authorisation alone is left to the gateway;
 *  - an order that leaves the cohort between its id read and its load is not read;
 *  - the run takes the job's lock, reads at most `limit` orders, and new closes never starve
 *    a repeat read or pending work;
 *  - refund failures, network faults included, fail the run and are reported once;
 *  - a marker left by a gateway refund that failed to import is retried for the rest only;
 *  - `limit: 1` still reaches a closed order while pending work is due.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { refundedPaise } from "./harness-refunds";

/** The gateway's refund call; everything else in the module stays real. */
const mockCreateRefund = jest.fn(
  async (params: {
    amount?: number;
    receipt?: string;
    idempotencyKey?: string;
  }) => ({
    refundId: `rfnd_dbtier_${params.receipt ?? params.idempotencyKey}`,
    amount: params.amount ?? 0,
    currency: "INR",
    status: "SUCCEEDED" as const,
  }),
);
jest.mock("../../../lib/payments/index", () => ({
  ...jest.requireActual("../../../lib/payments/index"),
  createRefund: (params: {
    amount?: number;
    receipt?: string;
    idempotencyKey?: string;
  }) => mockCreateRefund(params),
}));

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
/** Every report that would reach Sentry: not expected, not info. */
const mockSentryReports: string[] = [];
jest.mock("../../../lib/observability/report", () => {
  const actual = jest.requireActual("../../../lib/observability/report");
  const note = (
    what: string,
    opts?: { expected?: boolean; level?: string },
  ) => {
    if (!opts?.expected && opts?.level !== "info") mockSentryReports.push(what);
  };
  return {
    ...actual,
    reportSentryError: (error: unknown, opts: { expected?: boolean }) => {
      note(error instanceof Error ? error.message : String(error), opts);
      return actual.reportSentryError(error, opts);
    },
    reportSentryMessage: (message: string, opts: { expected?: boolean }) => {
      note(message, opts);
      return actual.reportSentryMessage(message, opts);
    },
  };
});

import {
  hasPaymentStatusReconcileWork,
  reconcilePaymentStatus,
} from "../../../scripts/payments/reconcile-payment-status";
import { cleanupExpiredApprovalPendingPayments } from "../../../scripts/payments/cleanup-abandoned-payments";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { CronLockHeldError } from "../../../lib/cron/with-cron-lock";
import { refundPayment } from "../../../lib/payments/operations/refund";
import { refundDoor } from "./harness-edges";
import { RefundError } from "../../../lib/payments/core/types";
import { retryAutoRefunds } from "../../../scripts/payments/retry-auto-refunds";

const PRICE_PAISE = 80_000;

/** What Razorpay answers per order (`/orders/:id/payments`) and per payment (`/payments/:id/refunds`). */
const gatewayOrders = new Map<string, Array<Record<string, unknown>>>();
const gatewayRefunds = new Map<string, Array<Record<string, unknown>>>();
const ORDER_PAYMENTS = /\/v1\/orders\/([^/]+)\/payments$/;
const PAYMENT_REFUNDS = /\/v1\/payments\/([^/?]+)\/refunds(?:\?(.*))?$/;
/** Payments whose refund list the gateway cannot serve right now. */
const unreadableRefunds = new Set<string>();
const mockFetch = jest.fn(async (input: string | URL) => {
  const url = String(input);
  const order = ORDER_PAYMENTS.exec(url)?.[1];
  if (order) {
    const items = gatewayOrders.get(decodeURIComponent(order)) ?? [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  }
  const [, payment, query] = PAYMENT_REFUNDS.exec(url) ?? [];
  if (payment) {
    if (unreadableRefunds.has(decodeURIComponent(payment))) {
      return new Response("{}", { status: 503 });
    }
    // Razorpay pages refunds: 10 unless `count` says otherwise, from `skip`.
    const page = new URLSearchParams(query);
    const skip = Number(page.get("skip") ?? 0);
    const items = (gatewayRefunds.get(decodeURIComponent(payment)) ?? []).slice(
      skip,
      skip + Number(page.get("count") ?? 10),
    );
    return new Response(JSON.stringify({ items }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: "created" }), { status: 200 });
});
const readsOf = (orderId: string) =>
  mockFetch.mock.calls.filter(([input]) =>
    String(input).includes(`/orders/${orderId}/payments`),
  ).length;
const statusReadsOf = (orderId: string) =>
  mockFetch.mock.calls.filter(([input]) =>
    String(input).endsWith(`/orders/${orderId}`),
  ).length;

const gatewayPaymentId = () =>
  `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

/** An approved request whose pay link lapsed, its order still PENDING. */
async function lapsedApproval() {
  const startsAt = futureAt(4, 10);
  return seedOneToOne(
    "consultation",
    await seedHost(),
    await seedConsultee(),
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: {
        status: "PENDING",
        amount: PRICE_PAISE,
        expiresAt: new Date(Date.now() - 5 * 60_000),
      },
    },
  );
}

/** A booking whose order we already closed `minutesAgo` minutes ago. */
async function closedOrder(minutesAgo: number) {
  const startsAt = futureAt(5, 9);
  const request = await seedOneToOne(
    "consultation",
    await seedHost(),
    await seedConsultee(),
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "EXPIRED",
      isTentative: false,
      payment: { status: "EXPIRED", amount: PRICE_PAISE },
    },
  );
  await closedAt(request.payment!.id, minutesAgo);
  return request;
}

const HOUR = 60;
const closedAt = (paymentId: string, minutesAgo: number) =>
  prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${paymentId}`;
const lastReadAt = (paymentId: string, minutesAgo: number) =>
  prisma.$executeRaw`UPDATE "Payment" SET "lastReconciledAt" = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${paymentId}`;
/** Moves a row's close and last read `minutes` into the past, as if that much time went by. */
const timePasses = (paymentId: string, minutes: number) =>
  prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = "updatedAt" - make_interval(mins => ${minutes}), "lastReconciledAt" = "lastReconciledAt" - make_interval(mins => ${minutes}) WHERE id = ${paymentId}`;
const descriptionOf = async (paymentId: string) =>
  (
    await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { description: true },
    })
  ).description;
const consultationStatus = async (id: string) =>
  (
    await prisma.consultation.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    })
  ).status;

const captured = (id: string, amount = PRICE_PAISE) => ({
  id,
  status: "captured",
  amount,
  currency: "INR",
  notes: {},
});

describe("reconcile-payment-status re-reads orders we closed", () => {
  const realFetch = global.fetch;

  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_dbtier";
    process.env.RAZORPAY_SECRET = "dbtier_secret";
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  beforeEach(async () => {
    gatewayOrders.clear();
    gatewayRefunds.clear();
    unreadableRefunds.clear();
    mockFetch.mockClear();
    mockCreateRefund.mockClear();
    mockSentryReports.length = 0;
    // A gateway capture's booking refund is the real gateway refund; only the HTTP call is stubbed.
    refundDoor.refundBookingPayment
      .mockReset()
      .mockImplementation((input: Parameters<typeof refundPayment>[0]) =>
        refundPayment(input),
      );
    // Rows earlier tests and suites left behind leave every cohort, so each test reads only its own.
    await prisma.$executeRaw`UPDATE "Payment" SET "description" = 'REQUIRES_MANUAL_RECOVERY: parked by the closed-order suite' WHERE "paymentStatus" IN ('PENDING', 'EXPIRED') AND ("description" IS NULL OR NOT starts_with("description", 'REQUIRES_MANUAL_RECOVERY:'))`;
    await prisma.$executeRaw`UPDATE "Payment" SET "description" = 'REQUIRES_MANUAL_RECOVERY: parked by the closed-order suite' WHERE starts_with("description", 'Auto-refund pending:')`;
  });

  it("refunds a capture on an order the sweep closed an hour ago, once, and confirms nothing", async () => {
    const request = await lapsedApproval();
    const orderId = request.payment!.paymentIntent;
    expect((await cleanupExpiredApprovalPendingPayments()).errors).toEqual([]);
    const closed = await prisma.payment.findUniqueOrThrow({
      where: { id: request.payment!.id },
      select: { paymentStatus: true, updatedAt: true },
    });
    expect(closed.paymentStatus).toBe("EXPIRED");
    expect(closed.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await closedAt(request.payment!.id, HOUR);
    const payId = gatewayPaymentId();
    gatewayOrders.set(orderId, [captured(payId)]);

    const run = await reconcilePaymentStatus();

    expect(run.lateCaptures).toEqual([request.payment!.id]);
    expect(readsOf(orderId)).toBe(1);
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: request.payment!.id,
        amountPaise: PRICE_PAISE,
        dedupeKey: `late-capture:${payId}`,
        gatewayReceipt: `late_capture_${payId}`,
      }),
    );
    expect(mockCreateRefund).toHaveBeenCalledTimes(1);
    expect(mockCreateRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: orderId,
        amount: PRICE_PAISE,
        receipt: `late_capture_${payId}`,
      }),
    );
    expect(await refundedPaise(request.payment!.id)).toBe(PRICE_PAISE);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: request.payment!.id },
      select: { paymentStatus: true, gatewayPaymentId: true },
    });
    expect(payment).toEqual({
      paymentStatus: "SUCCEEDED",
      gatewayPaymentId: payId,
    });
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: request.consultationId! },
      select: { status: true },
    });
    expect(consultation.status).toBe("EXPIRED");

    // The webhook arrives late: the capture is already recorded, so nothing more is refunded.
    await handlePaymentSuccess(
      orderId,
      request.captureMetadata,
      PRICE_PAISE,
      payId,
    );
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
    // Had both reached the refund, the payment's key would answer with the first refund.
    const first = await prisma.refund.findFirstOrThrow({
      where: { paymentId: request.payment!.id },
      select: { id: true, dedupeKey: true },
    });
    expect(first.dedupeKey).toBe(`late-capture:${payId}`);
    await expect(
      refundPayment({
        paymentId: request.payment!.id,
        reason: "capture after hold release (a second door)",
        initiatedByUserId: null,
        dedupeKey: `late-capture:${payId}`,
        gatewayReceipt: `late_capture_${payId}`,
      }),
    ).resolves.toMatchObject({ refundId: first.id });
    expect(mockCreateRefund).toHaveBeenCalledTimes(1);
    expect(await refundedPaise(request.payment!.id)).toBe(PRICE_PAISE);

    // The recorded capture has left the cohort.
    mockFetch.mockClear();
    await reconcilePaymentStatus();
    expect(readsOf(orderId)).toBe(0);
  });

  it("never reads an order past the final-read grace, one already read after its 72 hours, or a pre-mint placeholder", async () => {
    const old = await closedOrder(100 * HOUR);
    gatewayOrders.set(old.payment!.paymentIntent, [
      captured(gatewayPaymentId()),
    ]);
    const finalReadDone = await closedOrder(80 * HOUR);
    await lastReadAt(finalReadDone.payment!.id, 7 * HOUR);
    gatewayOrders.set(finalReadDone.payment!.paymentIntent, [
      captured(gatewayPaymentId()),
    ]);
    const placeholder = await closedOrder(HOUR);
    const premint = `premint_${randomUUID()}`;
    await prisma.payment.update({
      where: { id: placeholder.payment!.id },
      data: { paymentIntent: premint },
    });
    gatewayOrders.set(premint, [captured(gatewayPaymentId())]);

    await reconcilePaymentStatus();

    expect(readsOf(old.payment!.paymentIntent)).toBe(0);
    expect(readsOf(finalReadDone.payment!.paymentIntent)).toBe(0);
    expect(readsOf(premint)).toBe(0);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });

  it("loads closed orders through the probe's predicate, so an order that leaves the cohort after its id is read is not worked", async () => {
    const request = await closedOrder(HOUR);
    const paymentId = request.payment!.id;
    const orderId = request.payment!.paymentIntent;
    gatewayOrders.set(orderId, [captured(gatewayPaymentId())]);
    expect(
      await hasPaymentStatusReconcileWork(prisma, new Date(), () => false),
    ).toBe(true);

    const realQueryRaw = prisma.$queryRaw.bind(prisma);
    let idRead = false;
    const queryRaw = jest.spyOn(prisma, "$queryRaw").mockImplementation((async (
      ...args: Parameters<typeof prisma.$queryRaw>
    ) => {
      const rows: unknown = await realQueryRaw(...args);
      if (Array.isArray(rows) && rows.some((r) => r?.id === paymentId)) {
        idRead = true;
        // The capture's webhook lands between the id read and the load.
        await prisma.payment.updateMany({
          where: { id: paymentId, paymentStatus: "EXPIRED" },
          data: { capturedAt: new Date() },
        });
      }
      return rows;
    }) as typeof prisma.$queryRaw);
    try {
      const run = await reconcilePaymentStatus();
      expect(idRead).toBe(true);
      expect(run.closedOrdersRead).toBe(0);
    } finally {
      queryRaw.mockRestore();
    }
    expect(readsOf(orderId)).toBe(0);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });

  it("leaves an authorisation alone: nothing is captured, recorded or refunded by us", async () => {
    const request = await closedOrder(2 * HOUR);
    const orderId = request.payment!.paymentIntent;
    gatewayOrders.set(orderId, [
      { ...captured(gatewayPaymentId()), status: "authorized" },
    ]);

    const run = await reconcilePaymentStatus();

    expect(readsOf(orderId)).toBe(1);
    expect(run.lateCaptures).toEqual([]);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: request.payment!.id },
      select: { paymentStatus: true, capturedAt: true },
    });
    expect(payment).toEqual({ paymentStatus: "EXPIRED", capturedAt: null });
    expect(
      mockFetch.mock.calls.some(([input]) =>
        /\/capture|\/refund/.test(String(input)),
      ),
    ).toBe(false);
  });

  it("reads nothing while another run holds the lock, and at most `limit` orders a run, least recently read first", async () => {
    // Never read since their close, they queue at their close time, oldest first.
    const orders = [
      await closedOrder(3 * HOUR),
      await closedOrder(3 * HOUR),
      await closedOrder(3 * HOUR),
    ].map((r) => r.payment!);
    // Read an hour ago, so it queues after the three.
    const readEarlier = (await closedOrder(3 * HOUR)).payment!;
    await lastReadAt(readEarlier.id, HOUR);

    const held = await prisma.systemJobExecution.create({
      data: {
        jobId: "reconcile-payment-status",
        jobName: "reconcile-payment-status",
        status: "RUNNING",
      },
    });
    await expect(reconcilePaymentStatus({ limit: 2 })).rejects.toBeInstanceOf(
      CronLockHeldError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    await prisma.systemJobExecution.update({
      where: { id: held.id },
      data: { status: "COMPLETED", endedAt: new Date() },
    });

    const first = await reconcilePaymentStatus({ limit: 2 });
    expect(first.closedOrdersRead).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(orders.map((p) => readsOf(p.paymentIntent))).toEqual([1, 1, 0]);

    mockFetch.mockClear();
    await reconcilePaymentStatus({ limit: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(
      [...orders, readEarlier].map((p) => readsOf(p.paymentIntent)),
    ).toEqual([0, 0, 1, 1]);
  });
  /** A closed order captured at the gateway, part of it already refunded from the dashboard (₹300 by default). */
  async function partlyRefundedCapture(
    refunds: { amount: number; status: string }[] = [
      { amount: 30_000, status: "processed" },
    ],
  ) {
    const request = await closedOrder(HOUR);
    const orderId = request.payment!.paymentIntent;
    const payId = gatewayPaymentId();
    gatewayOrders.set(orderId, [
      {
        ...captured(payId),
        amount_refunded: refunds.reduce((sum, r) => sum + r.amount, 0),
      },
    ]);
    gatewayRefunds.set(
      payId,
      refunds.map((r) => ({
        id: `rfnd_dash_${randomUUID().slice(0, 8)}`,
        currency: "INR",
        notes: {},
        ...r,
      })),
    );
    return { request, orderId, payId };
  }

  const refundCallsFor = (orderId: string) =>
    mockCreateRefund.mock.calls.filter(
      ([params]) =>
        (params as { paymentIntentId?: string }).paymentIntentId === orderId,
    );

  it("records every gateway refund past Razorpay's first page before refunding the rest", async () => {
    const { request, orderId } = await partlyRefundedCapture(
      Array.from({ length: 11 }, () => ({
        amount: 1_000,
        status: "processed",
      })),
    );

    const run = await reconcilePaymentStatus();

    expect(run.errors).toEqual([]);
    expect(refundCallsFor(orderId)).toEqual([
      [expect.objectContaining({ amount: 69_000 })],
    ]);
    expect(await refundedPaise(request.payment!.id)).toBe(PRICE_PAISE);
  });

  it("leaves the marker while a gateway refund it imported is still pending, and refunds nothing over it", async () => {
    const { request, orderId } = await partlyRefundedCapture([
      { amount: 30_000, status: "pending" },
    ]);
    const paymentId = request.payment!.id;
    unreadableRefunds.add(
      (gatewayOrders.get(orderId)![0] as { id: string }).id,
    );
    await reconcilePaymentStatus();
    unreadableRefunds.clear();
    await closedAt(paymentId, 20);

    await retryAutoRefunds();

    expect(refundCallsFor(orderId)).toEqual([]);
    expect(await descriptionOf(paymentId)).toMatch(/^Auto-refund pending:/);
  });

  it("records a refund already made at the gateway and refunds only the rest, once", async () => {
    const { request, orderId, payId } = await partlyRefundedCapture();

    const run = await reconcilePaymentStatus();
    await reconcilePaymentStatus();
    await handlePaymentSuccess(
      orderId,
      request.captureMetadata,
      PRICE_PAISE,
      payId,
    );

    expect(run.errors).toEqual([]);
    expect(run.lateCaptures).toEqual([request.payment!.id]);
    expect(mockCreateRefund).toHaveBeenCalledTimes(1);
    expect(mockCreateRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50_000 }),
    );
    expect(await refundedPaise(request.payment!.id)).toBe(PRICE_PAISE);
    expect(await consultationStatus(request.consultationId!)).toBe("EXPIRED");
  });

  it("reads an order once more after its 72 hours, so a capture in the last interval is refunded, and then stops", async () => {
    const capturedLate = (await closedOrder(71 * HOUR + 50)).payment!;
    const stillAuthorised = (await closedOrder(71 * HOUR + 50)).payment!;
    const lateId = gatewayPaymentId();
    gatewayOrders.set(capturedLate.paymentIntent, [
      { ...captured(lateId), status: "authorized" },
    ]);
    gatewayOrders.set(stillAuthorised.paymentIntent, [
      { ...captured(gatewayPaymentId()), status: "authorized" },
    ]);

    await reconcilePaymentStatus();
    // Fifteen minutes on, both are past their 72 hours; one was captured in between.
    await timePasses(capturedLate.id, 15);
    await timePasses(stillAuthorised.id, 15);
    gatewayOrders.set(capturedLate.paymentIntent, [captured(lateId)]);
    const finalRun = await reconcilePaymentStatus();

    expect(finalRun.lateCaptures).toEqual([capturedLate.id]);
    expect(mockCreateRefund).toHaveBeenCalledTimes(1);
    expect(await refundedPaise(capturedLate.id)).toBe(PRICE_PAISE);
    expect(readsOf(stillAuthorised.paymentIntent)).toBe(2);

    await timePasses(stillAuthorised.id, 15);
    mockFetch.mockClear();
    await reconcilePaymentStatus();
    expect(readsOf(stillAuthorised.paymentIntent)).toBe(0);
  });

  it("keeps reading an order already read, and pending work, while new closes keep arriving", async () => {
    const polled = (await closedOrder(5 * HOUR)).payment!;
    await lastReadAt(polled.id, HOUR);
    gatewayOrders.set(polled.paymentIntent, [captured(gatewayPaymentId())]);
    const pending = (await lapsedApproval()).payment!;
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '30 minutes', "lastReconciledAt" = now() - interval '1 hour' WHERE id = ${pending.id}`;

    const reads: number[] = [];
    let firstRun = { polled: 0, pending: 0 };
    for (let run = 0; run < 3; run++) {
      await closedOrder(0);
      await closedOrder(0);
      await reconcilePaymentStatus({ limit: 2 });
      reads.push(mockFetch.mock.calls.length);
      if (run === 0) {
        firstRun = {
          polled: readsOf(polled.paymentIntent),
          pending: statusReadsOf(pending.paymentIntent),
        };
      }
      mockFetch.mockClear();
    }

    expect(firstRun).toEqual({ polled: 1, pending: 1 });
    expect(await refundedPaise(polled.id)).toBe(PRICE_PAISE);
    expect(reads.every((n) => n <= 2)).toBe(true);
  });

  it("fails the run and reports once when late-capture refunds fail, leaving each marker for the retry", async () => {
    const first = (await closedOrder(HOUR)).payment!;
    const second = (await closedOrder(HOUR)).payment!;
    gatewayOrders.set(first.paymentIntent, [captured(gatewayPaymentId())]);
    gatewayOrders.set(second.paymentIntent, [captured(gatewayPaymentId())]);
    const noBalance = () =>
      new RefundError(
        "Your account does not have enough balance to carry out the refund operation",
        "BAD_REQUEST_ERROR",
        "RAZORPAY",
      );
    mockCreateRefund
      .mockRejectedValueOnce(noBalance())
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    const run = await reconcilePaymentStatus();

    expect(run.success).toBe(false);
    expect(run.lateCaptures).toEqual([]);
    expect(run.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(first.id),
        expect.stringContaining(second.id),
      ]),
    );
    expect(await descriptionOf(first.id)).toMatch(/^Auto-refund pending:/);
    expect(await descriptionOf(second.id)).toMatch(/^Auto-refund pending:/);
    expect(mockSentryReports).toEqual([
      expect.stringContaining(
        "2 late capture(s) on closed orders not refunded",
      ),
    ]);
    // The gateway client is told the run reports, so a network fault is not reported per row either.
    expect(mockCreateRefund.mock.calls).toEqual([
      [expect.objectContaining({ failureReportedByCaller: true })],
      [expect.objectContaining({ failureReportedByCaller: true })],
    ]);
  });

  it("retries a marker whose gateway refund failed to import by recording it and refunding only the rest, once", async () => {
    const { request, orderId } = await partlyRefundedCapture();
    const paymentId = request.payment!.id;
    unreadableRefunds.add(
      (gatewayOrders.get(orderId)![0] as { id: string }).id,
    );
    const run = await reconcilePaymentStatus();
    expect(run.errors).toEqual([expect.stringContaining(paymentId)]);
    expect(await descriptionOf(paymentId)).toMatch(/^Auto-refund pending:/);
    expect(mockCreateRefund).not.toHaveBeenCalled();

    // The gateway answers again; the retry runs past its grace.
    unreadableRefunds.clear();
    await closedAt(paymentId, 20);
    await retryAutoRefunds();
    await closedAt(paymentId, 20);
    await retryAutoRefunds();

    expect(refundCallsFor(orderId)).toEqual([
      [expect.objectContaining({ amount: 50_000 })],
    ]);
    expect(await refundedPaise(paymentId)).toBe(PRICE_PAISE);
    expect(await descriptionOf(paymentId)).toMatch(/^Auto-refunded:/);
  });

  it("reaches a closed order in one run at `limit: 1` while pending work is due", async () => {
    const closed = (await closedOrder(HOUR)).payment!;
    const pending = (await lapsedApproval()).payment!;
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '30 minutes' WHERE id = ${pending.id}`;

    const run = await reconcilePaymentStatus({ limit: 1 });

    expect(run.closedOrdersRead).toBe(1);
    expect(readsOf(closed.paymentIntent)).toBe(1);
    expect(statusReadsOf(pending.paymentIntent)).toBe(1);
  });
});
