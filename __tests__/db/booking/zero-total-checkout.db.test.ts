/**
 * A full discount with no credits: the order never reaches the gateway, the
 * booking is confirmed at birth on the no-gateway rail and keeps its discount
 * use, and cancelling it settles cleanly with no money to move.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { futureAt, seedHost } from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
  seedConsultationPlan,
} from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeEndedBookingChatAccess: jest.fn(async () => undefined),
  revokeEndedEventChatAccess: jest.fn(async () => undefined),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";

it("a 100% discount books on the no-gateway rail and cancels cleanly", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await seedConsultationPlan(host, "Comp consultation");
  const buyer = await seedBuyer();
  const code = await prisma.discountCode.create({
    data: {
      code: `COMP-${randomUUID().slice(0, 8).toUpperCase()}`,
      description: "comp",
      discountType: "PERCENTAGE",
      discountValue: 100,
      maxUses: 10,
    },
  });

  await handleCheckout(
    {
      ...consultationCheckout(plan.id, futureAt(6, 10), `comp-${randomUUID()}`),
      discountCode: code.code,
    },
    buyer.userId,
  );

  const gateway = jest.requireMock("../../../lib/payments/index") as {
    createPaymentIntent: jest.Mock;
  };
  expect(gateway.createPaymentIntent).not.toHaveBeenCalled();
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
  });
  expect(payment.paymentStatus).toBe("SUCCEEDED");
  expect(Number(payment.amount)).toBe(0);
  expect(payment.paymentIntent.startsWith("free_")).toBe(true);
  expect(
    (await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } }))
      .currentUses,
  ).toBe(1);

  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  const res = await cancel(
    new NextRequest(
      `http://localhost/api/appointments/${payment.appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "SCHEDULE_CONFLICT" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId: payment.appointmentId! }) },
  );
  expect(res.status).toBe(200);
  // A paid booking keeps its use, refunded or not.
  expect(
    (await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } }))
      .currentUses,
  ).toBe(1);
});
