/**
 * A platform code never makes a paid order free: the profitability floor caps
 * a 100% code and the rest goes through the gateway. Only a ₹0 plan takes the
 * no-gateway rail, and cancelling that booking settles with no money to move.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { readActiveFeeSchedule } from "../../../lib/payments/pricing/platform-fee";
import { platformFundedCapPaise } from "../../../lib/payments/pricing/platform-funded-cap";
import { currentGstRegime } from "../../../lib/payments/tax/gst-regime";
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
  revokeEndedSeatAccess: jest.fn(async () => undefined),
  persistSeatRevocation: jest.fn(async () => undefined),
  persistSeatRevocationInTx: jest.fn(async () => null),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";

const gateway = () =>
  jest.requireMock("../../../lib/payments/index") as {
    createPaymentIntent: jest.Mock;
  };

beforeEach(() => jest.clearAllMocks());

it("a 100% platform code is capped by the floor and the rest is charged through the gateway", async () => {
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

  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
  });
  const cap = platformFundedCapPaise({
    listPaise: 100_000,
    platformFeeBps: (await readActiveFeeSchedule(prisma)).marketplaceBps,
    gstRegistered: currentGstRegime() === "REGISTERED",
  });
  const charged = Number(payment.amount);
  expect(cap).toBeGreaterThan(0);
  expect(
    Number(payment.originalAmount) - (charged - Number(payment.taxAmount)),
  ).toBe(cap);
  expect(charged).toBeGreaterThan(0);
  expect(payment.paymentStatus).toBe("PENDING");
  expect(gateway().createPaymentIntent).toHaveBeenCalledWith(
    expect.objectContaining({ amount: charged }),
  );
  expect(
    (await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } }))
      .currentUses,
  ).toBe(1);
});

it("a ₹0 plan books on the no-gateway rail and cancels cleanly", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await prisma.consultationPlan.create({
    data: {
      title: "Free consultation",
      price: BigInt(0),
      consultantProfileId: host.consultantProfileId,
      durationInHours: 1,
    },
  });
  const buyer = await seedBuyer();

  await handleCheckout(
    consultationCheckout(plan.id, futureAt(6, 10), `free-${randomUUID()}`),
    buyer.userId,
  );

  expect(gateway().createPaymentIntent).not.toHaveBeenCalled();
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
  });
  expect(payment.paymentStatus).toBe("SUCCEEDED");
  expect(Number(payment.amount)).toBe(0);
  expect(payment.paymentIntent.startsWith("free_")).toBe(true);

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
});
