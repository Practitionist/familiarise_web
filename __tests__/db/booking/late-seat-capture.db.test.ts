/**
 * A capture promotes a HELD webinar seat only while checkout would still sell
 * it to this buyer: a session still ahead, and no other live booking of the
 * buyer's at that time. Otherwise the seat is released and the capture takes
 * the refund path.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { seedWebinar } from "./harness-seats";

/** A buyer holding an unpaid seat on a webinar that starts at `startsAt`. */
async function heldSeatOn(startsAt?: Date) {
  const webinar = await seedWebinar({ capacity: 5, startsAt });
  const buyer = await seedConsultee();
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
      expiresAt: new Date(Date.now() + 10 * 60_000),
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  const seat = await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "HELD",
      paymentId: payment.id,
    },
  });
  return { webinar, buyer, seatId: seat.id };
}

const capture = (appointmentId: string, payerUserId: string) =>
  prisma.$transaction(
    (tx) => confirmExistingAppointment(tx, appointmentId, payerUserId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

const seatStatus = async (seatId: string) =>
  (
    await prisma.appointmentParticipant.findUniqueOrThrow({
      where: { id: seatId },
      select: { status: true },
    })
  ).status;

describe("a capture on a HELD webinar seat", () => {
  it("confirms the seat while the session is ahead and the buyer is free", async () => {
    const { webinar, buyer, seatId } = await heldSeatOn();

    const result = await capture(webinar.appointmentId, buyer.userId);

    expect(result).toEqual({ capturedAfterTerminal: false });
    expect(await seatStatus(seatId)).toBe("CONFIRMED");
  });

  it("releases the seat and reports a late capture once the session has ended", async () => {
    const { webinar, buyer, seatId } = await heldSeatOn(
      new Date(Date.now() - 3 * HOUR_MS),
    );

    const result = await capture(webinar.appointmentId, buyer.userId);

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(await seatStatus(seatId)).toBe("CANCELLED");
    const event = await prisma.systemEvent.findFirst({
      where: { correlationId: `capture-unseated-seat:${seatId}` },
      select: { message: true },
    });
    expect(event?.message).toContain("the webinar has ended");
  });

  it("releases the seat when the buyer holds a confirmed session at that time", async () => {
    const { webinar, buyer, seatId } = await heldSeatOn();
    await seedOneToOne(
      "consultation",
      await seedHost(),
      buyer,
      { startsAt: webinar.startsAt, endsAt: webinar.endsAt },
      { status: "APPROVED", isTentative: false },
    );

    const result = await capture(webinar.appointmentId, buyer.userId);

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(await seatStatus(seatId)).toBe("CANCELLED");
  });

  it("leaves a seat that is already CONFIRMED alone after the session has ended", async () => {
    const { webinar, buyer, seatId } = await heldSeatOn(
      new Date(Date.now() - 3 * HOUR_MS),
    );
    await prisma.appointmentParticipant.update({
      where: { id: seatId },
      data: { status: "CONFIRMED" },
    });

    const result = await capture(webinar.appointmentId, buyer.userId);

    expect(result).toEqual({ capturedAfterTerminal: false });
    expect(await seatStatus(seatId)).toBe("CONFIRMED");
  });
});
