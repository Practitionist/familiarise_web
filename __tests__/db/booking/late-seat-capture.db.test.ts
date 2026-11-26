/**
 * A capture promotes a HELD seat only while checkout would still sell it to
 * this buyer: a session still ahead, enrolment open for a class, and no other
 * live booking of the buyer's at that time. A seat paid for while its hold was
 * live skips the enrolment rule. Otherwise the seat is released and the
 * capture takes the refund path.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { CLASS_UNDER_WAY, seedClassUnderWay } from "./harness-class-series";
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

const capture = (
  appointmentId: string,
  payerUserId: string,
  opts?: { paidInsideHold: boolean },
) =>
  prisma.$transaction(
    (tx) => confirmExistingAppointment(tx, appointmentId, payerUserId, opts),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

/** A buyer holding an unpaid seat on a class whose first three sessions have run and that allows no late join. */
async function heldSeatOnClassUnderWay() {
  const cls = await seedClassUnderWay(await seedHost(), CLASS_UNDER_WAY);
  const buyer = await seedConsultee();
  const price = BigInt(CLASS_UNDER_WAY.price);
  const payment = await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      appointmentId: cls.appointmentId,
      isMockPayment: true,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  const seat = await prisma.appointmentParticipant.create({
    data: {
      appointmentId: cls.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "HELD",
      paymentId: payment.id,
    },
  });
  return { cls, buyer, seatId: seat.id };
}

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

describe("a capture on a HELD class seat after enrolment has closed", () => {
  it("releases the seat when the processing time decides", async () => {
    const { cls, buyer, seatId } = await heldSeatOnClassUnderWay();

    const result = await capture(cls.appointmentId, buyer.userId);

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(await seatStatus(seatId)).toBe("CANCELLED");
  });

  it("confirms the seat when the gateway took the money while the hold was live", async () => {
    const { cls, buyer, seatId } = await heldSeatOnClassUnderWay();

    const result = await capture(cls.appointmentId, buyer.userId, {
      paidInsideHold: true,
    });

    expect(result).toEqual({ capturedAfterTerminal: false });
    expect(await seatStatus(seatId)).toBe("CONFIRMED");
  });

  it("still releases a seat paid inside its hold once every session is over", async () => {
    const { cls, buyer, seatId } = await heldSeatOnClassUnderWay();
    // Every session moves into the past, each to its own hour: one host's sessions may not overlap.
    const sessions = await prisma.appointmentOccurrence.findMany({
      where: { appointmentId: cls.appointmentId },
      select: { id: true },
      orderBy: { startsAt: "asc" },
    });
    const firstStart = Date.now() - 30 * 24 * HOUR_MS;
    for (const [i, session] of sessions.entries()) {
      const startsAt = new Date(firstStart + i * 2 * HOUR_MS);
      await prisma.appointmentOccurrence.update({
        where: { id: session.id },
        data: { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      });
    }

    const result = await capture(cls.appointmentId, buyer.userId, {
      paidInsideHold: true,
    });

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(await seatStatus(seatId)).toBe("CANCELLED");
  });

  it("still releases a seat paid inside its hold when the buyer is busy at a remaining session", async () => {
    const { cls, buyer, seatId } = await heldSeatOnClassUnderWay();
    const next = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: { appointmentId: cls.appointmentId, startsAt: { gt: new Date() } },
      orderBy: { startsAt: "asc" },
    });
    await seedOneToOne(
      "consultation",
      await seedHost(),
      buyer,
      { startsAt: next.startsAt, endsAt: next.endsAt },
      { status: "APPROVED", isTentative: false },
    );

    const result = await capture(cls.appointmentId, buyer.userId, {
      paidInsideHold: true,
    });

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(await seatStatus(seatId)).toBe("CANCELLED");
  });
});
