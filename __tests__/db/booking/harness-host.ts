/** 1:1 seeds for the database tier: published hosts, plans, buyers and requests. */
import prisma from "../../../lib/prisma";
import {
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
