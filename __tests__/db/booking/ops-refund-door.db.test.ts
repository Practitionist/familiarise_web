/**
 * The Ops panel's "Issue refund", the issue door and the legacy admin door read
 * one eligibility on real rows: a free seat, a credit booking already restored
 * and a disputed payment are refused before the refund writer runs; a
 * refundable one opens. A refund key replays only on the payment it was spent on.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";
import { refundDoor } from "./harness-edges";
import {
  seatCheckoutInput,
  seedHeldSeat,
  seedSeatBuyer,
  seedWebinar,
  type SeededWebinar,
} from "./harness-seats";

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
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));
jest.mock("../../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => undefined),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { readBookingOps } from "../../../lib/backoffice/booking-ops-read";
import { POST as issueRefund } from "../../../app/api/admin/refunds/issue/route";
import { POST as legacyRefund } from "../../../app/api/admin/refunds/route";
import { findDedupedRefund } from "../../../lib/payments/operations/refund";

beforeAll(async () => {
  mockAdmin.id = (await seedUser("ADMIN")).userId;
});
beforeEach(() => refundDoor.refundBookingPayment.mockClear());

/** What the panel's link opens: a full refund through the issue door. */
const issue = (paymentId: string, idempotencyKey: string = randomUUID()) =>
  issueRefund(
    new NextRequest("https://x.test/api/admin/refunds/issue", {
      method: "POST",
      body: JSON.stringify({
        paymentId,
        idempotencyKey,
        reason: "learner asked for a refund",
      }),
    }),
    { params: Promise.resolve({}) },
  );

/** The legacy admin door: its key rides the Idempotency-Key header. */
const legacyIssue = (paymentId: string) =>
  legacyRefund(
    new NextRequest("https://x.test/api/admin/refunds", {
      method: "POST",
      headers: { "Idempotency-Key": `legacy-${randomUUID()}` },
      body: JSON.stringify({ paymentId, reason: "learner asked for a refund" }),
    }),
    { params: Promise.resolve({}) },
  );

const seatStatus = (appointmentId: string, userId: string) =>
  prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId, userId },
    select: { status: true },
  });

async function panelRow(webinar: SeededWebinar, paymentId: string) {
  const view = await readBookingOps(webinar.appointmentId);
  return view?.payments.find((p) => p.id === paymentId);
}

/** A credit-funded ₹500 seat; `restored` adds the ₹0 refund row the credits rail writes. */
async function creditSeat(webinar: SeededWebinar, restored: boolean) {
  const buyer = await seedSeatBuyer();
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(0),
      originalAmount: BigInt(50_000),
      paymentMethod: "credits",
      paymentIntent: `free_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
    },
  });
  const credit = await prisma.referralCredit.create({
    data: {
      userId: buyer.userId,
      amount: BigInt(50_000),
      usedAmount: BigInt(restored ? 0 : 50_000),
      remainingAmount: BigInt(restored ? 50_000 : 0),
      source: "REFEREE_BONUS",
      state: "VESTED",
      vestedAt: new Date(),
      idempotencyKey: `dbtier-credit:${randomUUID()}`,
    },
  });
  await prisma.referralCreditUsage.create({
    data: {
      creditId: credit.id,
      paymentId: payment.id,
      amount: BigInt(restored ? 0 : 50_000),
      originalAmount: BigInt(50_000),
      restoredAmount: BigInt(restored ? 50_000 : 0),
    },
  });
  if (restored) {
    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amountPaise: BigInt(0),
        status: "SUCCEEDED",
        refundId: `credits_${randomUUID()}`,
        paymentGateway: "RAZORPAY",
      },
    });
  }
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: restored ? "REFUNDED" : "CONFIRMED",
      paymentId: payment.id,
    },
  });
  return payment;
}

it("a free seat offers no refund, and the door refuses it with the seat untouched", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 0 });
  const buyer = await seedSeatBuyer();
  await handleCheckout(
    seatCheckoutInput(webinar, `free-seat-${randomUUID()}`),
    buyer.userId,
  );
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: { id: true },
  });

  expect(await panelRow(webinar, payment.id)).toMatchObject({
    refundable: false,
  });
  const res = await issue(payment.id);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "PRICE_FREE_PAYMENT" });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  expect(
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
      select: { status: true },
    }),
  ).toEqual({ status: "CONFIRMED" });
});

it("a credit booking opens the door until its credits are restored", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const live = await creditSeat(webinar, false);
  const restored = await creditSeat(webinar, true);

  expect(await panelRow(webinar, live.id)).toMatchObject({ refundable: true });
  expect(await panelRow(webinar, restored.id)).toMatchObject({
    refundable: false,
  });
  const res = await issue(restored.id);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "ALREADY_FULLY_REFUNDED" });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
});

it("a card seat opens the door until a live dispute or a lost chargeback blocks it", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { payment: clean } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const { payment: disputed } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const { payment: chargedBack } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const dispute = (paymentId: string, status: "NEEDS_RESPONSE" | "LOST") =>
    prisma.dispute.create({
      data: {
        paymentId,
        amountPaise: BigInt(50_000),
        reason: "fraudulent",
        status,
        disputeId: `disp_dbtier_${randomUUID()}`,
        paymentGateway: "RAZORPAY",
      },
    });
  await dispute(disputed.id, "NEEDS_RESPONSE");
  await dispute(chargedBack.id, "LOST");

  expect(await panelRow(webinar, clean.id)).toMatchObject({
    refundable: true,
  });
  expect(await panelRow(webinar, disputed.id)).toMatchObject({
    refundable: false,
  });
  expect(await panelRow(webinar, chargedBack.id)).toMatchObject({
    refundable: false,
  });
  const res = await issue(disputed.id);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "REFUND_BLOCKED_BY_DISPUTE",
  });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();

  expect((await issue(clean.id)).status).toBe(200);
  expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
});

it("the legacy admin door refuses a free seat the same way, with the seat untouched", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 0 });
  const buyer = await seedSeatBuyer();
  await handleCheckout(
    seatCheckoutInput(webinar, `free-seat-${randomUUID()}`),
    buyer.userId,
  );
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: { id: true },
  });

  const res = await legacyIssue(payment.id);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "PRICE_FREE_PAYMENT" });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  expect(await seatStatus(webinar.appointmentId, buyer.userId)).toEqual({
    status: "CONFIRMED",
  });
});

it("a key spent on one buyer's refund answers 422 on another buyer's payment", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const a = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const b = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const key = randomUUID();
  const spent = await prisma.refund.create({
    data: {
      paymentId: a.payment.id,
      amountPaise: BigInt(50_000),
      status: "SUCCEEDED",
      refundId: `rfnd_dbtier_${randomUUID()}`,
      dedupeKey: `ops:${key}`,
      paymentGateway: "RAZORPAY",
    },
  });

  const res = await issue(b.payment.id, key);
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  expect(await seatStatus(webinar.appointmentId, b.buyer.userId)).toEqual({
    status: "CONFIRMED",
  });

  // The writer's own lookup binds the key the same way on real rows.
  await expect(
    findDedupedRefund(`ops:${key}`, { paymentId: b.payment.id }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  await expect(
    findDedupedRefund(`ops:${key}`, { paymentId: a.payment.id }),
  ).resolves.toMatchObject({ refundId: spent.id, paymentId: a.payment.id });
});
