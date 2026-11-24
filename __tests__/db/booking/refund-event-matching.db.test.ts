/**
 * Refund webhook events against real rows: which Refund row an event claims and
 * which payment it may be booked on. Events are imported by the real handler.
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

/** A paid ₹500 consultation five days out. */
async function paidConsultation() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(5, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null, amount: PRICE_PAISE },
    },
  );
  return booking.payment!;
}

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
