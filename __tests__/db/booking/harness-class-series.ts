/** Class-series seeds for the database tier: a class under way, its paid seats, and the host's cancel. */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { HOUR_MS, type SeededHost } from "./harness";
import { seedSeatBuyer } from "./harness-seats";
import { sessionUser } from "./harness-session";

const DAY_MS = 24 * HOUR_MS;

export type ClassShape = { price: number; sessions: number; delivered: number };

/** Ten sessions at ₹100, three already delivered: the exit right needs 3 misses. */
export const CLASS_UNDER_WAY: ClassShape = {
  price: 10_000,
  sessions: 10,
  delivered: 3,
};

/** A class of `sessions`, the first `delivered` already held ten days ago, the rest from two days out. */
export async function seedClassUnderWay(host: SeededHost, shape: ClassShape) {
  const now = Date.now();
  const plan = await prisma.classPlan.create({
    data: {
      title: `Database tier class ${randomUUID().slice(0, 8)}`,
      price: BigInt(shape.price),
      totalSessions: shape.sessions,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const cls = await prisma.class.create({
    data: { classPlanId: plan.id, status: "SCHEDULED" },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "CLASS", classId: cls.id },
  });
  const occurrenceIds: string[] = [];
  for (let i = 0; i < shape.sessions; i += 1) {
    const offsetDays = i < shape.delivered ? i - 10 : i + 2;
    const startsAt = new Date(now + offsetDays * DAY_MS);
    const occ = await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: i < shape.delivered ? "COMPLETED" : "SCHEDULED",
      },
    });
    occurrenceIds.push(occ.id);
  }
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: appointment.id,
      userId: host.userId,
      role: "CONSULTANT",
      status: "CONFIRMED",
    },
  });
  return { classId: cls.id, appointmentId: appointment.id, occurrenceIds };
}

/** A buyer who paid for the whole class by card twenty days ago and holds a confirmed seat. */
export async function seatClassBuyer(
  cls: { appointmentId: string },
  shape: Pick<ClassShape, "price" | "sessions">,
) {
  const buyer = await seedSeatBuyer();
  const boughtAt = new Date(Date.now() - 20 * DAY_MS);
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(shape.price),
      originalAmount: BigInt(shape.price),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: cls.appointmentId,
      isMockPayment: true,
      createdAt: boughtAt,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(shape.price) }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: cls.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment.id,
      sessionsPurchased: shape.sessions,
      createdAt: boughtAt,
    },
  });
  return { userId: buyer.userId, paymentId: payment.id };
}

/** The host cancels the whole class through the real cancel route. */
export async function hostCancels(host: SeededHost, appointmentId: string) {
  sessionUser.current = {
    id: host.userId,
    role: "CONSULTANT",
    consultantProfileId: host.consultantProfileId,
    consulteeProfileId: null,
    name: "Host",
  };
  const res = await cancel(
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
  return { status: res.status, body: (await res.json()) as unknown };
}
