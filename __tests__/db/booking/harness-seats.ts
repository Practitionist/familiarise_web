/** Group-event seeds for the database tier: a verified host's webinar and its seat holders. */
import { randomUUID } from "node:crypto";
import { Prisma, type PaymentStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";
import { HOUR_MS, futureAt, seedHost, type SeededHost } from "./harness";

/** A verified host with a published webinar of `capacity` seats at `startsAt`. */
export async function seedWebinar(
  args: { capacity: number; startsAt?: Date; price?: number } = {
    capacity: 20,
  },
) {
  const host = await seedHost();
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED" },
  });
  const startsAt = args.startsAt ?? futureAt(6, 9);
  const endsAt = new Date(startsAt.getTime() + HOUR_MS);
  const plan = await prisma.webinarPlan.create({
    data: {
      title: `Database tier webinar ${randomUUID().slice(0, 8)}`,
      price: BigInt(args.price ?? 50_000),
      maxParticipants: args.capacity,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      webinarPlanId: plan.id,
      status: "SCHEDULED",
      maxParticipants: args.capacity,
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "WEBINAR", webinarId: webinar.id },
  });
  await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      ordinal: 1,
      startsAt,
      endsAt,
      isTentative: false,
      consultantProfileId: host.consultantProfileId,
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: appointment.id,
      userId: host.userId,
      role: "CONSULTANT",
      status: "CONFIRMED",
    },
  });
  return {
    host,
    planId: plan.id,
    webinarId: webinar.id,
    appointmentId: appointment.id,
    startsAt,
    endsAt,
  };
}
export type SeededWebinar = Awaited<ReturnType<typeof seedWebinar>>;

/** A buyer who can check out: a consultee profile with a billing state. */
export async function seedSeatBuyer() {
  const { userId } = await seedUser("CONSULTEE");
  await prisma.consulteeProfile.create({
    data: { userId, billingStateCode: "29" },
  });
  return { userId };
}

/** A seat already held on the webinar with its own payment (e.g. a buyer mid-checkout). */
export async function seedHeldSeat(
  webinar: SeededWebinar,
  args: { status: PaymentStatus; expiresAt: Date | null },
) {
  const buyer = await seedSeatBuyer();
  const price = BigInt(50_000);
  const payment = await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: args.status,
      userId: buyer.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
      expiresAt: args.expiresAt,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: args.status === "SUCCEEDED" ? "CONFIRMED" : "HELD",
      paymentId: payment.id,
    },
  });
  return { buyer, payment };
}

/** Seats that hold a place right now, read straight from the table. */
export async function liveSeatCount(appointmentId: string): Promise<number> {
  const [{ seats }] = await prisma.$queryRaw<{ seats: number }[]>(Prisma.sql`
    SELECT count(*)::int AS seats
    FROM "AppointmentParticipant" p
    LEFT JOIN "Payment" pay ON pay.id = p."paymentId"
    WHERE p."appointmentId" = ${appointmentId}
      AND p.role = 'CONSULTEE'
      AND (p.status = 'CONFIRMED'
        OR (p.status = 'HELD' AND pay."paymentStatus" = 'PENDING'
            AND (pay."expiresAt" IS NULL OR pay."expiresAt" > now())))`);
  return seats;
}

/** The checkout body a seat buyer sends. */
export function seatCheckoutInput(webinar: SeededWebinar, key: string) {
  return {
    appointmentType: "WEBINAR" as const,
    planId: webinar.planId,
    eventId: webinar.webinarId,
    paymentGateway: "RAZORPAY" as const,
    clientIdempotencyKey: key,
    consumerStateCode: "29",
  };
}

export type { SeededHost };
