/**
 * Refund webhook events against real rows: which Refund row an event claims and
 * which payment it may be booked on. Events are imported by the real handler.
 */
import { randomUUID } from "node:crypto";
import type { PaymentStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));

import { handleRefundCreated } from "../../../app/api/webhooks/utils";

const PRICE_PAISE = 50_000;

/** A ₹500 consultation five days out whose order is in `status`, with the gateway payment id the row holds. */
async function consultationOrder(
  status: PaymentStatus,
  gatewayPaymentId: string | null,
) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(5, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: status === "SUCCEEDED" ? "APPROVED" : "PENDING",
      isTentative: status !== "SUCCEEDED",
      payment: { status, expiresAt: null, amount: PRICE_PAISE },
    },
  );
  const payment = booking.payment!;
  if (gatewayPaymentId) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayPaymentId },
    });
  }
  return payment;
}

const paidConsultation = () => consultationOrder("SUCCEEDED", null);

const unmatchedEvents = (gatewayRefundId: string) =>
  prisma.systemEvent.findMany({
    where: {
      category: "PAYMENT",
      correlationId: `refund-unmatched:${gatewayRefundId}`,
    },
    select: { severity: true, context: true },
  });

const refundsOf = (paymentId: string) =>
  prisma.refund.findMany({
    where: { paymentId },
    select: { id: true, refundId: true, status: true, cascadedAt: true },
  });

it("a late refund.processed claims the FAILED placeholder its notes name and clears the marker that placeholder drove", async () => {
  const payment = await paidConsultation();
  const key = `owed:${randomUUID()}`;
  // The owed marker's own drive: reserved, then failed by the reconciler.
  const placeholder = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: BigInt(20_000),
      status: "FAILED",
      refundId: `pending_${randomUUID()}`,
      dedupeKey: key,
      paymentGateway: "RAZORPAY",
      failedAt: new Date(),
    },
  });
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      refundOwedKey: key,
      refundOwedPaise: BigInt(20_000),
      refundOwedReason: "db tier owed refund",
      refundOwedAt: new Date(),
      refundOwedAttempts: 1,
    },
  });
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;

  const deliver = () =>
    handleRefundCreated(
      gatewayRefundId,
      payment.paymentIntent,
      20_000,
      "INR",
      "processed",
      undefined,
      { reservationId: placeholder.id },
    );
  await deliver();
  await deliver();

  const rows = await refundsOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: placeholder.id,
    refundId: gatewayRefundId,
    status: "SUCCEEDED",
  });
  expect(rows[0].cascadedAt).not.toBeNull();
  const after = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
    select: { refundOwedKey: true, refundOwedPaise: true },
  });
  expect(after).toEqual({ refundOwedKey: null, refundOwedPaise: null });
});

it("books the refund of the captured gateway payment and nothing for another attempt on the same order", async () => {
  const captured = `pay_dbtier_${randomUUID()}`;
  const payment = await consultationOrder("SUCCEEDED", captured);
  const otherAttempt = `pay_dbtier_${randomUUID()}`;
  const strayRefund = `rfnd_dbtier_${randomUUID()}`;
  const ownRefund = `rfnd_dbtier_${randomUUID()}`;

  // The gateway's own refund of a different attempt, delivered as created then processed.
  for (const status of ["created", "processed"]) {
    await handleRefundCreated(
      strayRefund,
      payment.paymentIntent,
      PRICE_PAISE,
      "INR",
      status,
      otherAttempt,
    );
  }
  expect(await refundsOf(payment.id)).toHaveLength(0);
  const events = await unmatchedEvents(strayRefund);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    severity: "ERROR",
    context: expect.objectContaining({
      gatewayRefundId: strayRefund,
      orderId: payment.paymentIntent,
      gatewayPaymentId: otherAttempt,
      capturedGatewayPaymentId: captured,
    }),
  });

  await handleRefundCreated(
    ownRefund,
    payment.paymentIntent,
    20_000,
    "INR",
    "processed",
    captured,
    undefined,
    true,
  );
  const rows = await refundsOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ refundId: ownRefund, status: "SUCCEEDED" });
  expect(rows[0].cascadedAt).not.toBeNull();
  expect(await unmatchedEvents(ownRefund)).toHaveLength(0);
});

it.each(["EXPIRED", "FAILED"] as const)(
  "books nothing on a %s order, though the row holds the refunded attempt's id",
  async (status) => {
    const failedAttempt = `pay_dbtier_${randomUUID()}`;
    const payment = await consultationOrder(status, failedAttempt);
    const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;

    await handleRefundCreated(
      gatewayRefundId,
      payment.paymentIntent,
      PRICE_PAISE,
      "INR",
      "processed",
      failedAttempt,
    );

    expect(await refundsOf(payment.id)).toHaveLength(0);
    expect(await unmatchedEvents(gatewayRefundId)).toEqual([
      expect.objectContaining({
        severity: "WARN",
        context: expect.objectContaining({
          orderId: payment.paymentIntent,
          paymentStatus: status,
        }),
      }),
    ]);
  },
);

it("an embedded captured:false books nothing on a paid order and is acknowledged", async () => {
  const payment = await consultationOrder("SUCCEEDED", null);
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;

  const result = await handleRefundCreated(
    gatewayRefundId,
    payment.paymentIntent,
    PRICE_PAISE,
    "INR",
    "processed",
    `pay_dbtier_${randomUUID()}`,
    undefined,
    false,
  );

  expect(result).toBeUndefined();
  expect(await refundsOf(payment.id)).toHaveLength(0);
  expect(await unmatchedEvents(gatewayRefundId)).toHaveLength(1);
});
