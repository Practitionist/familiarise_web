/**
 * A booking refund decides its seat once, as its row settles SUCCEEDED, whichever path settles it:
 * the live refund writer or the refund webhook. Only settled refunds count as returned, and the
 * decision, the REFUNDED stamp and the revocation intent commit with the settle or not at all.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { handleRefundCreated } from "../../../app/api/webhooks/utils";
import { seedUser } from "../seed";
import { refundDoor } from "./harness-edges";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

const mockAdmin = { id: "" };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireBackofficeSurface: async () => ({
    session: {
      user: { id: mockAdmin.id, role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  }),
}));
jest.mock("../../../lib/backoffice/money-limit", () => ({
  __esModule: true,
  assertMoneyOpsBudget: jest.fn(async () => undefined),
}));
const mockCreateRefund = jest.fn(async (params: { amount: number }) => ({
  refundId: `rfnd_dbtier_${randomUUID()}`,
  amount: params.amount,
  currency: "INR",
  status: "SUCCEEDED" as "SUCCEEDED" | "PENDING",
}));
jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createRefund: (params: { amount: number }) => mockCreateRefund(params),
}));
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
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
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
const mockRevokeSeat = jest.fn(async () => undefined);
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeRefundedSeatAccess: () => mockRevokeSeat(),
}));
/** The real in-transaction intent writer, which a case can make fail once. */
const mockIntentInTx = jest.fn();
jest.mock("../../../lib/stream/revocation-intents", () => {
  const actual = jest.requireActual("../../../lib/stream/revocation-intents");
  return {
    ...actual,
    persistRefundRevocationInTx: (...a: unknown[]) => mockIntentInTx(...a),
  };
});

import { POST as issueRefund } from "../../../app/api/admin/refunds/issue/route";

beforeAll(async () => {
  mockAdmin.id = (await seedUser("ADMIN")).userId;
});
beforeEach(() => {
  mockCreateRefund.mockClear();
  mockRevokeSeat.mockClear();
  mockIntentInTx.mockReset();
  mockIntentInTx.mockImplementation(
    jest.requireActual("../../../lib/stream/revocation-intents")
      .persistRefundRevocationInTx,
  );
  const writer = jest.requireActual(
    "../../../lib/payments/operations/booking-refund",
  ) as { refundBookingPayment: (...a: unknown[]) => unknown };
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(
    writer.refundBookingPayment,
  );
});

const issue = (body: Record<string, unknown>) =>
  issueRefund(
    new NextRequest("https://x.test/api/admin/refunds/issue", {
      method: "POST",
      body: JSON.stringify({ reason: "goodwill for a late start", ...body }),
    }),
    { params: Promise.resolve({}) },
  );

it("resending a ₹100 partial refund's key with no amount replays it and keeps the ₹500 seat", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const idempotencyKey = randomUUID();

  const first = await issue({
    paymentId: payment.id,
    idempotencyKey,
    amountPaise: 10_000,
  });
  expect(first.status).toBe(200);
  const { result } = (await first.json()) as { result: { refundId: string } };

  const replay = await issue({ paymentId: payment.id, idempotencyKey });
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { result: unknown }).result).toMatchObject({
    refundId: result.refundId,
    amountRefundedPaise: 10_000,
  });

  const refunds = await prisma.refund.findMany({
    where: { paymentId: payment.id },
    select: { amountPaise: true, status: true, metadata: true },
  });
  expect(
    refunds.map((r) => ({ ...r, amountPaise: Number(r.amountPaise) })),
  ).toEqual([
    expect.objectContaining({
      amountPaise: 10_000,
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: false }),
    }),
  ]);
  expect(mockCreateRefund).toHaveBeenCalledTimes(1);
  expect(mockRevokeSeat).not.toHaveBeenCalled();
  expect(
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
      select: { status: true },
    }),
  ).toEqual({ status: "CONFIRMED" });
});

it("keeps the seat when a concurrent ₹400 refund fails while this ₹100 one is at the gateway", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const other = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: BigInt(40_000),
      status: "PENDING",
      refundId: `pending_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });
  // At this refund's reservation the other was still out; it fails before the gateway answers.
  mockCreateRefund.mockImplementationOnce(async (params) => {
    await prisma.refund.updateMany({
      where: { id: other.id, status: "PENDING" },
      data: { status: "FAILED", failedAt: new Date() },
    });
    return {
      refundId: `rfnd_dbtier_${randomUUID()}`,
      amount: params.amount,
      currency: "INR",
      status: "SUCCEEDED" as const,
    };
  });

  const res = await issue({
    paymentId: payment.id,
    idempotencyKey: randomUUID(),
    amountPaise: 10_000,
  });

  expect(res.status).toBe(200);
  expect(
    await prisma.refund.findFirstOrThrow({
      where: { paymentId: payment.id, status: "SUCCEEDED" },
      select: { metadata: true },
    }),
  ).toMatchObject({ metadata: expect.objectContaining({ endsSeat: false }) });
  expect(mockRevokeSeat).not.toHaveBeenCalled();
  expect(
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
      select: { status: true },
    }),
  ).toEqual({ status: "CONFIRMED" });
});

/** The gateway accepts the refund and answers PENDING under this id. */
const gatewayPending = (refundId: string) =>
  mockCreateRefund.mockImplementationOnce(async (params) => ({
    refundId,
    amount: params.amount,
    currency: "INR",
    status: "PENDING" as const,
  }));
const seatOf = (appointmentId: string, userId: string) =>
  prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId, userId },
    select: { status: true },
  });
const rowOf = (paymentId: string, amountPaise: number) =>
  prisma.refund.findFirstOrThrow({
    where: { paymentId, amountPaise: BigInt(amountPaise) },
    select: { id: true, status: true, metadata: true, cascadedAt: true },
  });
const revocationIntents = (refundRowId: string) =>
  prisma.streamRevocationRetry.count({
    where: { kind: "REFUND_ACCESS_REVOKE", planId: refundRowId },
  });

it.each<[string, "processed" | "failed", string]>([
  ["its webhook settle ends the seat", "processed", "REFUNDED"],
  ["its failure leaves the seat kept", "failed", "CONFIRMED"],
])(
  "a ₹100 partial that settles while a ₹400 refund is PENDING keeps the ₹500 seat; then %s",
  async (_case, event, seat) => {
    const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
    const { buyer, payment } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    const gatewayId = `rfnd_dbtier_${randomUUID()}`;
    gatewayPending(gatewayId);
    await issue({
      paymentId: payment.id,
      idempotencyKey: randomUUID(),
      amountPaise: 40_000,
    });
    await issue({
      paymentId: payment.id,
      idempotencyKey: randomUUID(),
      amountPaise: 10_000,
    });

    expect(await rowOf(payment.id, 10_000)).toMatchObject({
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: false }),
    });
    expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
      status: "CONFIRMED",
    });
    expect(await rowOf(payment.id, 40_000)).toMatchObject({
      status: "PENDING",
    });

    await handleRefundCreated(
      gatewayId,
      payment.paymentIntent,
      40_000,
      "INR",
      event,
    );

    expect(await rowOf(payment.id, 40_000)).toMatchObject({
      status: event === "processed" ? "SUCCEEDED" : "FAILED",
    });

    const settled = await rowOf(payment.id, 40_000);
    expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
      status: seat,
    });
    expect(await revocationIntents(settled.id)).toBe(
      event === "processed" ? 1 : 0,
    );
  },
);

it("a full refund whose gateway call timed out ends the seat when the webhook settles its reservation", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  // Razorpay took the refund, but the HTTP call dropped before it answered.
  mockCreateRefund.mockImplementationOnce(async () => {
    throw new Error("socket hang up");
  });
  await issue({ paymentId: payment.id, idempotencyKey: randomUUID() });
  const reservation = await rowOf(payment.id, 50_000);
  expect(reservation).toMatchObject({ status: "PENDING" });
  expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
    status: "CONFIRMED",
  });

  await handleRefundCreated(
    `rfnd_dbtier_${randomUUID()}`,
    payment.paymentIntent,
    50_000,
    "INR",
    "processed",
    undefined,
    { reservationId: reservation.id },
  );

  expect(await rowOf(payment.id, 50_000)).toMatchObject({
    status: "SUCCEEDED",
    metadata: expect.objectContaining({ endsSeat: true }),
  });
  expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
    status: "REFUNDED",
  });
  expect(await revocationIntents(reservation.id)).toBe(1);
});

it("a settle whose revocation intent fails rolls the SUCCEEDED flip back, and the next settle decides", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const gatewayId = `rfnd_dbtier_${randomUUID()}`;
  gatewayPending(gatewayId);
  await issue({ paymentId: payment.id, idempotencyKey: randomUUID() });
  mockIntentInTx.mockRejectedValueOnce(new Error("revocation table down"));
  const settle = () =>
    handleRefundCreated(
      gatewayId,
      payment.paymentIntent,
      50_000,
      "INR",
      "processed",
    );

  await expect(settle()).rejects.toThrow("revocation table down");
  const rolledBack = await rowOf(payment.id, 50_000);
  expect(rolledBack).toMatchObject({ status: "PENDING", cascadedAt: null });
  expect(rolledBack.metadata).not.toHaveProperty("endsSeat");
  expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
    status: "CONFIRMED",
  });

  await settle();
  expect(await rowOf(payment.id, 50_000)).toMatchObject({
    status: "SUCCEEDED",
    metadata: expect.objectContaining({ endsSeat: true }),
  });
  expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
    status: "REFUNDED",
  });
  expect(await revocationIntents(rolledBack.id)).toBe(1);
});

it("a webhook row that settled before the live bind inherits the reservation's intent and ends the seat", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const gatewayId = `rfnd_dbtier_${randomUUID()}`;
  // Razorpay's webhook lands first and, without our notes, records its own SUCCEEDED row.
  mockCreateRefund.mockImplementationOnce(async (params) => {
    await handleRefundCreated(
      gatewayId,
      payment.paymentIntent,
      params.amount,
      "INR",
      "processed",
    );
    return {
      refundId: gatewayId,
      amount: params.amount,
      currency: "INR",
      status: "SUCCEEDED" as const,
    };
  });
  const writer = jest.requireActual(
    "../../../lib/payments/operations/booking-refund",
  ) as typeof import("../../../lib/payments/operations/booking-refund");

  // ₹250 of the ₹500, with no partial rule: the refund ends the seat. Both rows fit the payment until the bind.
  await writer.refundBookingPayment({
    paymentId: payment.id,
    amountPaise: 25_000,
    reason: "cancellation",
    dedupeKey: `cancel:${randomUUID()}`,
  });

  const rows = await prisma.refund.findMany({
    where: { paymentId: payment.id },
    select: { id: true, refundId: true, status: true, metadata: true },
  });
  expect(rows).toEqual([
    expect.objectContaining({
      refundId: gatewayId,
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: true }),
    }),
  ]);
  expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
    status: "REFUNDED",
  });
  expect(await revocationIntents(rows[0]?.id ?? "")).toBe(1);
});

it.each<[string, "processed" | "failed", string]>([
  ["its webhook settle ends the seat", "processed", "REFUNDED"],
  ["its failure leaves the seat kept", "failed", "CONFIRMED"],
])(
  "an Ops Full refund beside a PENDING ₹400 sends ₹100 and keeps the ₹500 seat; then %s",
  async (_case, event, seat) => {
    const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
    const { buyer, payment } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    const gatewayId = `rfnd_dbtier_${randomUUID()}`;
    gatewayPending(gatewayId);
    await issue({
      paymentId: payment.id,
      idempotencyKey: randomUUID(),
      amountPaise: 40_000,
    });
    // A second operator issues Full: no amount, so the reservation sends what the ₹400 left.
    const full = await issue({
      paymentId: payment.id,
      idempotencyKey: randomUUID(),
    });
    expect(full.status).toBe(200);

    expect(await rowOf(payment.id, 10_000)).toMatchObject({
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: false }),
    });
    expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
      status: "CONFIRMED",
    });
    expect(await rowOf(payment.id, 40_000)).toMatchObject({
      status: "PENDING",
    });

    await handleRefundCreated(
      gatewayId,
      payment.paymentIntent,
      40_000,
      "INR",
      event,
    );

    expect(await rowOf(payment.id, 40_000)).toMatchObject({
      status: event === "processed" ? "SUCCEEDED" : "FAILED",
    });

    expect(await seatOf(webinar.appointmentId, buyer.userId)).toEqual({
      status: seat,
    });
  },
);
