/**
 * A dual-role buyer (an expert who also books as a client) is walled out of a
 * time only by seats that still hold it: a lapsed seat hold (its payment
 * PENDING past its deadline) never blocks their own next booking.
 */
import prisma from "../../../lib/prisma";
import { seedDualRole } from "./harness";
import { seedWebinar } from "./harness-seats";
import { consulteeHasOverlappingSession } from "../../../lib/payments/checkout/occupancy-validate";
import { randomUUID } from "node:crypto";

async function dualRoleSeatOn(expiresAt: Date) {
  const webinar = await seedWebinar({ capacity: 5 });
  const buyer = await seedDualRole();
  const price = BigInt(50_000);
  const payment = await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
      expiresAt,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "HELD",
      paymentId: payment.id,
    },
  });
  return { webinar, buyer };
}

const overlaps = (userId: string, window: { startsAt: Date; endsAt: Date }) =>
  prisma.$transaction((tx) =>
    consulteeHasOverlappingSession(tx, {
      userId,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      selfHoldAppointmentIds: [],
    }),
  );

it("a lapsed seat hold does not wall a dual-role buyer out of the same time", async () => {
  const { webinar, buyer } = await dualRoleSeatOn(
    new Date(Date.now() - 60_000),
  );
  expect(await overlaps(buyer.userId, webinar)).toBe(false);
});

it("a live seat hold still does", async () => {
  const { webinar, buyer } = await dualRoleSeatOn(
    new Date(Date.now() + 10 * 60_000),
  );
  expect(await overlaps(buyer.userId, webinar)).toBe(true);
});
