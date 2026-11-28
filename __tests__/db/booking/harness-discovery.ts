/**
 * Import first in a database-tier suite that drives a gateway discovery pass:
 * it registers the mocks for the pass's edges (the gateway reads, Novu, email
 * rendering) before the webhook handlers load. The reads are answered through
 * `gatewayReads` in `./harness-edges`.
 */
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
jest.mock("../../../lib/payments/core/razorpay", () =>
  jest.requireActual("./harness-edges").razorpayCoreMock(),
);
jest.mock("../../../lib/payments/core/razorpay-disputes", () =>
  jest.requireActual("./harness-edges").razorpayDisputesMock(),
);

import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

export const CONSULTATION_PRICE_PAISE = 50_000;

/** A run deadline that never passes. */
export const never = () => false;

/** A paid ₹500 consultation five days out whose row holds its captured gateway payment id. */
export async function seedCapturedConsultation() {
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
      payment: {
        status: "SUCCEEDED",
        expiresAt: null,
        amount: CONSULTATION_PRICE_PAISE,
      },
    },
  );
  const gatewayPaymentId = `pay_dbtier_${randomUUID()}`;
  const payment = await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: { gatewayPaymentId },
  });
  return { host, payment, gatewayPaymentId };
}
