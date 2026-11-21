/** 1:1 seeds for the database tier: published hosts, plans, buyers and requests. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  type SeededConsultee,
  type SeededHost,
} from "./harness";

/** One custom row covering the next 30 days, so coverage checks pass for any future hour. */
export async function publishEveryHour(host: SeededHost) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      startsAt: new Date(Date.now() - HOUR_MS),
      endsAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
    },
  });
}

/** Narrows the host's published hours to [startsAt, endsAt) (an availability shrink). */
export async function publishOnly(
  host: SeededHost,
  window: { startsAt: Date; endsAt: Date },
) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.deleteMany({
    where: { consultantProfileId: host.consultantProfileId },
  });
  await prisma.availabilityWindowCustom.create({
    data: { consultantProfileId: host.consultantProfileId, ...window },
  });
}

export async function seedConsultationPlan(host: SeededHost, title: string) {
  return prisma.consultationPlan.create({
    data: {
      title,
      price: BigInt(100_000),
      consultantProfileId: host.consultantProfileId,
      durationInHours: 1,
    },
  });
}

/** A consultee who can check out (billing state recorded). */
export async function seedBuyer(): Promise<SeededConsultee> {
  const buyer = await seedConsultee();
  await prisma.consulteeProfile.update({
    where: { id: buyer.consulteeProfileId },
    data: { billingStateCode: "29" },
  });
  return buyer;
}

/** A paid trial holding its time five days out, with its 200-rupee card order PENDING until `expiresAt`. */
export async function seedPaidTrialHold(
  host: SeededHost,
  subscriptionPlanId: string,
  expiresAt: Date,
) {
  // Lazy: the trial booking graph loads only for suites that seed one.
  const { bookTrialInTx } = await import("../../../lib/trials/book-trial");
  const buyer = await seedBuyer();
  const startsAt = futureAt(5, 10);
  const trial = await prisma.$transaction((tx) =>
    bookTrialInTx(tx, {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId,
      organizationId: null,
      consulteeUserId: buyer.userId,
      consultantUserId: host.userId,
      paid: true,
      agreedPricePaise: 20_000,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    }),
  );
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(20_000),
      originalAmount: BigInt(20_000),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      appointmentId: trial.appointmentId,
      isMockPayment: true,
      expiresAt,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(20_000) }] },
    },
  });
  return { buyer, trial, payment, startsAt };
}

/** A consultation request awaiting its times (no appointment yet). */
export async function seedRequest(
  host: SeededHost,
  consultee: SeededConsultee,
) {
  const plan = await seedConsultationPlan(host, "Database tier request");
  const consultation = await prisma.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestedById: consultee.consulteeProfileId,
      status: "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
    },
  });
  return { planId: plan.id, consultationId: consultation.id };
}

/** The 30-minute interval starts (ISO) of `hours` hours from `startsAt`. */
export const halfHourStarts = (startsAt: Date, hours = 1) =>
  Array.from({ length: hours * 2 }, (_, i) =>
    new Date(startsAt.getTime() + i * 30 * 60_000).toISOString(),
  );

/** A 1:1 checkout body for one window. */
export function consultationCheckout(
  planId: string,
  startsAt: Date,
  key: string,
) {
  return {
    appointmentType: "CONSULTATION" as const,
    planId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
    paymentGateway: "RAZORPAY" as const,
    clientIdempotencyKey: key,
    consumerStateCode: "29",
  };
}
