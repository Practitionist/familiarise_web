/**
 * `reconcile-payment-status` re-reads orders we closed in the last 72 hours, on real Postgres:
 *  - a capture found on an order the expiry sweep closed is refunded once and confirms nothing;
 *  - a later webhook for the same capture refunds nothing more;
 *  - an order closed 80 hours ago, and a pre-mint placeholder, are never read;
 *  - an authorisation alone is left to the gateway;
 *  - the run takes the job's lock and reads at most `limit` orders, least recently read first.
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
  async (params: { amount?: number; receipt?: string }) => ({
    refundId: `rfnd_dbtier_${params.receipt ?? "none"}`,
    amount: params.amount ?? 0,
    currency: "INR",
    status: "SUCCEEDED" as const,
  }),
);
jest.mock("../../../lib/payments/index", () => ({
  ...jest.requireActual("../../../lib/payments/index"),
  createRefund: (params: { amount?: number; receipt?: string }) =>
    mockCreateRefund(params),
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

import { reconcilePaymentStatus } from "../../../scripts/payments/reconcile-payment-status";
import { cleanupExpiredApprovalPendingPayments } from "../../../scripts/payments/cleanup-abandoned-payments";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { CronLockHeldError } from "../../../lib/cron/with-cron-lock";
import { refundPayment } from "../../../lib/payments/operations/refund";
import { refundDoor } from "./harness-edges";

const PRICE_PAISE = 80_000;

/** What Razorpay answers per order for `GET /v1/orders/:id/payments`; anything unlisted holds nothing. */
const gatewayOrders = new Map<string, Array<Record<string, unknown>>>();
const mockFetch = jest.fn(async (input: string | URL) => {
  const url = String(input);
  const payments = /\/v1\/orders\/([^/]+)\/payments$/.exec(url);
  if (payments) {
    const items = gatewayOrders.get(decodeURIComponent(payments[1])) ?? [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: "created" }), { status: 200 });
});
const readsOf = (orderId: string) =>
  mockFetch.mock.calls.filter(([input]) =>
    String(input).includes(`/orders/${orderId}/payments`),
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

/** A booking whose order we already closed `hoursAgo` hours ago. */
async function closedOrder(hoursAgo: number) {
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
  await closedAt(request.payment!.id, hoursAgo);
  return request;
}

const closedAt = (paymentId: string, hoursAgo: number) =>
  prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${paymentId}`;

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
    mockFetch.mockClear();
    mockCreateRefund.mockClear();
    // A gateway capture's booking refund is the real gateway refund; only the HTTP call is stubbed.
    refundDoor.refundBookingPayment
      .mockReset()
      .mockImplementation((input: Parameters<typeof refundPayment>[0]) =>
        refundPayment(input),
      );
    // Rows other suites left behind were read most recently, so this test's rows come first.
    await prisma.$executeRaw`UPDATE "Payment" SET "lastReconciledAt" = now()`;
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
    await closedAt(request.payment!.id, 1);
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

  it("never reads an order closed 80 hours ago, or a pre-mint placeholder", async () => {
    const old = await closedOrder(80);
    gatewayOrders.set(old.payment!.paymentIntent, [
      captured(gatewayPaymentId()),
    ]);
    const placeholder = await closedOrder(1);
    const premint = `premint_${randomUUID()}`;
    await prisma.payment.update({
      where: { id: placeholder.payment!.id },
      data: { paymentIntent: premint },
    });
    gatewayOrders.set(premint, [captured(gatewayPaymentId())]);

    await reconcilePaymentStatus();

    expect(readsOf(old.payment!.paymentIntent)).toBe(0);
    expect(readsOf(premint)).toBe(0);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });

  it("leaves an authorisation alone: nothing is captured, recorded or refunded by us", async () => {
    const request = await closedOrder(2);
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
    const orders = [
      await closedOrder(3),
      await closedOrder(3),
      await closedOrder(3),
    ]
      .map((r) => r.payment!)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // Read an hour ago: after the three never-read orders, before every other row.
    const readEarlier = (await closedOrder(3)).payment!;
    await prisma.$executeRaw`UPDATE "Payment" SET "lastReconciledAt" = now() - interval '1 hour' WHERE id = ${readEarlier.id}`;

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
});
