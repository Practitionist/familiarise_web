/**
 * A capture parked as REQUIRES_MANUAL_RECOVERY is visible to ops, on real Postgres:
 *  - the delivery that parks it writes one PAYMENT SystemEvent naming the payment, and a
 *    later delivery of the same capture writes none;
 *  - Stuck-work lists every SUCCEEDED parked payment the buyer has not been given back,
 *    with or without a booking, once, linking to the payment's page;
 *  - it does not list a confirmed payment, a parked payment refunded in full, or one the
 *    owed-refund queue already lists.
 */
import { randomUUID } from "node:crypto";
import type { PaymentStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { seedConsultee } from "./harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { readNeedsAttention } from "../../../lib/backoffice/needs-attention";

const PRICE_PAISE = 50_000;
const HOUR_MS = 3_600_000;

/** A payment on a fresh TRIAL booking (parentless by design, and here with no trial row), or on none. */
async function seedPayment(opts: {
  booked: boolean;
  status: PaymentStatus;
  description?: string;
  refundOwed?: boolean;
}) {
  const { userId } = await seedConsultee();
  const appointment = opts.booked
    ? await prisma.appointment.create({ data: { appointmentType: "TRIAL" } })
    : null;
  return prisma.payment.create({
    data: {
      amount: BigInt(PRICE_PAISE),
      originalAmount: BigInt(PRICE_PAISE),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: opts.status,
      userId,
      appointmentId: appointment?.id ?? null,
      isMockPayment: true,
      description: opts.description ?? null,
      capturedAt: opts.status === "SUCCEEDED" ? new Date() : null,
      ...(opts.refundOwed
        ? {
            refundOwedKey: `owed:${randomUUID()}`,
            refundOwedReason: "buyer cancelled",
            refundOwedAt: new Date(Date.now() - 2 * HOUR_MS),
          }
        : {}),
      legs: { create: [{ source: "CARD", amountPaise: BigInt(PRICE_PAISE) }] },
    },
  });
}

const PARKED = "REQUIRES_MANUAL_RECOVERY: parked by the visibility suite.";

it("records a parked capture once and lists only the parked payments the buyer has not been given back", async () => {
  const pending = await seedPayment({ booked: true, status: "PENDING" });
  const deliver = () =>
    handlePaymentSuccess(
      pending.paymentIntent,
      {},
      PRICE_PAISE,
      `pay_dbtier_${pending.id}`,
    );

  expect(await deliver()).toBeNull();
  const parked = await prisma.payment.findUniqueOrThrow({
    where: { id: pending.id },
  });
  expect(parked.paymentStatus).toBe("SUCCEEDED");
  expect(parked.description).toMatch(
    /^REQUIRES_MANUAL_RECOVERY: Trial booking .* has no trial\./,
  );
  await deliver();
  const events = await prisma.systemEvent.findMany({
    where: { correlationId: `parked-capture:${pending.id}` },
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ category: "PAYMENT", severity: "ERROR" });
  expect(events[0].context).toMatchObject({
    paymentId: pending.id,
    appointmentId: pending.appointmentId,
  });

  const unbooked = await seedPayment({
    booked: false,
    status: "SUCCEEDED",
    description: PARKED,
  });
  const confirmed = await seedPayment({ booked: true, status: "SUCCEEDED" });
  const refunded = await seedPayment({
    booked: true,
    status: "SUCCEEDED",
    description: PARKED,
  });
  await prisma.refund.create({
    data: {
      paymentId: refunded.id,
      amountPaise: BigInt(PRICE_PAISE),
      status: "SUCCEEDED",
      refundId: `rfnd_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });
  const owed = await seedPayment({
    booked: true,
    status: "SUCCEEDED",
    description: PARKED,
    refundOwed: true,
  });

  const queues = await readNeedsAttention();
  const listed = (key: string) => {
    const items = queues.find((q) => q.key === key)?.items;
    if (!items) throw new Error(`${key} read failed`);
    return [...items.oldest, ...items.newest];
  };
  const parkedItems = listed("parkedCaptures");
  const ids = parkedItems.map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining([pending.id, unbooked.id]));
  for (const absent of [confirmed.id, refunded.id, owed.id]) {
    expect(ids).not.toContain(absent);
  }
  expect(listed("refundsOwed").map((i) => i.id)).toContain(owed.id);
  expect(parkedItems.find((i) => i.id === pending.id)).toMatchObject({
    state: "Parked, booking exists",
    lastError: expect.stringMatching(/^REQUIRES_MANUAL_RECOVERY: Trial/),
    links: expect.arrayContaining([
      { label: "Payment", path: `payments/${pending.id}` },
    ]),
  });
  expect(parkedItems.find((i) => i.id === unbooked.id)?.state).toBe(
    "Parked, no booking",
  );
});
