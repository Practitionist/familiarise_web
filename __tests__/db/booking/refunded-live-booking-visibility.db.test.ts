/**
 * Stuck work lists a booking that is still live after a refund made outside the app covered its
 * payment, on real Postgres. Refunds are written by the real refund webhook handler (a gateway
 * dashboard refund) and the real app doors (the buyer's cancel, the booking refund door).
 *  - Listed: a full dashboard refund on a 1:1 booking or a webinar seat, and an app partial refund
 *    that a dashboard refund completes.
 *  - Not listed: a partial dashboard refund, a cancelled or completed session, an ended seat, a full
 *    refund on a booking the app cancelled, or a full refund an app door made on a live booking.
 */
import "./harness-cancel-route";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { OccurrenceCompletionStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { sessionUser } from "./harness-session";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

const mockCreateRefund = jest.fn(async (params: { amount: number }) => ({
  refundId: `rfnd_dbtier_${randomUUID()}`,
  amount: params.amount,
  currency: "INR",
  status: "SUCCEEDED" as const,
}));
jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createRefund: (params: { amount: number }) => mockCreateRefund(params),
}));
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
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { readNeedsAttention } from "../../../lib/backoffice/needs-attention";

type RefundDoor = (input: {
  paymentId: string;
  reason: string;
  amountPaise?: number;
  keepSeat?: boolean;
  keepSeatIfPartial?: boolean;
}) => Promise<unknown>;
const { refundBookingPayment } = jest.requireActual(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: RefundDoor };
const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const PRICE_PAISE = 50_000;

beforeEach(() => {
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(refundBookingPayment);
});

/** A paid ₹500 consultation five days out, its buyer signed in. */
async function paidConsultation(
  completionStatus: OccurrenceCompletionStatus = "SCHEDULED",
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
      status: "APPROVED",
      isTentative: false,
      completionStatus,
      payment: { status: "SUCCEEDED", expiresAt: null, amount: PRICE_PAISE },
    },
  );
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  return { appointmentId: booking.appointmentId, payment: booking.payment! };
}

/** A paid ₹500 webinar seat. */
async function paidSeat() {
  const webinar = await seedWebinar({ capacity: 20, price: PRICE_PAISE });
  const { payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  return { appointmentId: webinar.appointmentId, payment };
}

/** A refund made in the gateway dashboard, as its `refund.processed` webhook imports it. */
const dashboardRefund = (
  payment: { paymentIntent: string },
  amountPaise: number,
) =>
  handleRefundCreated(
    `rfnd_dbtier_${randomUUID()}`,
    payment.paymentIntent,
    amountPaise,
    "INR",
    "processed",
  );

/** A refund the app's booking refund door makes. */
const appRefund = (
  paymentId: string,
  opts: Omit<Parameters<RefundDoor>[0], "paymentId" | "reason">,
) => refundBookingPayment({ paymentId, reason: "db tier refund", ...opts });

const cancelAsBuyer = (appointmentId: string) =>
  cancel(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "SCHEDULE_CONFLICT" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

async function listed() {
  const queue = (await readNeedsAttention()).find(
    (q) => q.key === "refundedLiveBookings",
  );
  if (!queue?.items) throw new Error("refundedLiveBookings read failed");
  return [...queue.items.oldest, ...queue.items.newest];
}

const refundedPaise = async (paymentId: string) =>
  (
    await prisma.refund.findMany({
      where: { paymentId, status: "SUCCEEDED" },
      select: { amountPaise: true },
    })
  ).reduce((sum, r) => sum + Number(r.amountPaise), 0);

it("lists a live booking or seat a refund made outside the app covered in full", async () => {
  const full = await paidConsultation();
  await dashboardRefund(full.payment, PRICE_PAISE);
  const toppedUp = await paidConsultation();
  await appRefund(toppedUp.payment.id, {
    amountPaise: 20_000,
    keepSeatIfPartial: true,
  });
  await dashboardRefund(toppedUp.payment, 30_000);
  const seat = await paidSeat();
  await dashboardRefund(seat.payment, PRICE_PAISE);

  const items = await listed();
  const ids = items.map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(
    expect.arrayContaining([
      full.payment.id,
      toppedUp.payment.id,
      seat.payment.id,
    ]),
  );
  expect(await refundedPaise(toppedUp.payment.id)).toBe(PRICE_PAISE);
  expect(items.find((i) => i.id === full.payment.id)).toMatchObject({
    state:
      "Database tier consultee was refunded ₹500.00 in full outside the app for Database tier consultation, and the booking is still live. If it should end, cancel it from the booking's Ops actions; no further refund is due.",
    links: [
      { label: "Booking", path: `appointments?open=${full.appointmentId}` },
      { label: "Payment", path: `payments/${full.payment.id}` },
      {
        label: "Entity trace",
        path: `trace?kind=payment&id=${full.payment.id}`,
      },
    ],
  });
  expect(items.find((i) => i.id === seat.payment.id)?.state).toMatch(
    /, and their seat is still confirmed\. If the seat should end, ask the host to remove them; no further refund is due\.$/,
  );
});

it("does not list a partial refund, an ended booking or seat, or a full refund an app door made", async () => {
  const partial = await paidConsultation();
  await dashboardRefund(partial.payment, 20_000);
  const cancelled = await paidConsultation("CANCELLED");
  await dashboardRefund(cancelled.payment, PRICE_PAISE);
  const completed = await paidConsultation("COMPLETED");
  await dashboardRefund(completed.payment, PRICE_PAISE);
  const leftSeat = await paidSeat();
  await prisma.appointmentParticipant.updateMany({
    where: { paymentId: leftSeat.payment.id },
    data: { status: "CANCELLED" },
  });
  await dashboardRefund(leftSeat.payment, PRICE_PAISE);
  const appCancelled = await paidConsultation();
  expect((await cancelAsBuyer(appCancelled.appointmentId)).status).toBe(200);
  const appKept = await paidConsultation();
  await appRefund(appKept.payment.id, { keepSeat: true });

  // The app's own refunds went through: the cancel and the kept seat were refunded in full.
  expect(await refundedPaise(appCancelled.payment.id)).toBe(PRICE_PAISE);
  expect(await refundedPaise(appKept.payment.id)).toBe(PRICE_PAISE);
  const ids = (await listed()).map((i) => i.id);
  for (const absent of [
    partial,
    cancelled,
    completed,
    leftSeat,
    appCancelled,
    appKept,
  ]) {
    expect(ids).not.toContain(absent.payment.id);
  }
});
