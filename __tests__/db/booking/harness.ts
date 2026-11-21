/** Booking seeds and a mid-transaction barrier for the database tier; every row is UUID-scoped. */
import { randomUUID } from "node:crypto";
import {
  Prisma,
  type AppointmentStatus,
  type BookingSource,
  type OccurrenceCompletionStatus,
  type ParticipantStatus,
  type PaymentStatus,
} from "@prisma/client";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";

export const HOUR_MS = 3_600_000;

/** A future, half-hour-aligned instant `days` ahead at `hourUtc`:00. */
export function futureAt(days: number, hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

/** A verified expert: only a verified expert takes a new booking or payment. */
export async function seedHost() {
  const { userId } = await seedUser("CONSULTANT");
  const domain = await prisma.domain.create({
    data: { name: `db-tier-${randomUUID()}` },
  });
  const profile = await prisma.consultantProfile.create({
    data: {
      userId,
      domainId: domain.id,
      scheduleType: "WEEKLY",
      verificationStatus: "VERIFIED",
    },
  });
  return { userId, consultantProfileId: profile.id };
}
export type SeededHost = Awaited<ReturnType<typeof seedHost>>;

export async function seedConsultee() {
  const { userId } = await seedUser("CONSULTEE");
  const profile = await prisma.consulteeProfile.create({ data: { userId } });
  return { userId, consulteeProfileId: profile.id };
}
export type SeededConsultee = Awaited<ReturnType<typeof seedConsultee>>;

/** A dual-role user: an expert who also books other experts as a client. */
export async function seedDualRole() {
  const host = await seedHost();
  const profile = await prisma.consulteeProfile.create({
    data: { userId: host.userId },
  });
  return { ...host, consulteeProfileId: profile.id };
}

type HoldShape = {
  status: AppointmentStatus;
  bookingSource?: BookingSource;
  isTentative: boolean;
  completionStatus?: OccurrenceCompletionStatus;
  deletedAt?: Date | null;
  participantStatus?: ParticipantStatus;
  payment?: { status: PaymentStatus; expiresAt?: Date | null; amount?: number };
};

/**
 * One consultation (or subscription) with one occurrence on the host's
 * calendar, both parties seated, and an optional payment.
 */
export async function seedOneToOne(
  kind: "consultation" | "subscription",
  host: SeededHost,
  consultee: SeededConsultee,
  window: { startsAt: Date; endsAt: Date },
  shape: HoldShape,
) {
  const price = BigInt(shape.payment?.amount ?? 100_000);
  let consultationId: string | null = null;
  let subscriptionId: string | null = null;
  let planId: string;
  if (kind === "consultation") {
    const plan = await prisma.consultationPlan.create({
      data: {
        title: "Database tier consultation",
        price,
        consultantProfileId: host.consultantProfileId,
      },
    });
    planId = plan.id;
    const row = await prisma.consultation.create({
      data: {
        consultationPlanId: plan.id,
        requestedById: consultee.consulteeProfileId,
        status: shape.status,
        bookingSource: shape.bookingSource ?? "DIRECT_CHECKOUT",
      },
    });
    consultationId = row.id;
  } else {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Database tier subscription",
        price,
        consultantProfileId: host.consultantProfileId,
      },
    });
    planId = plan.id;
    const row = await prisma.subscription.create({
      data: {
        subscriptionPlanId: plan.id,
        requestedById: consultee.consulteeProfileId,
        status: shape.status,
        bookingSource: shape.bookingSource ?? "DIRECT_CHECKOUT",
        schedulingPeriodStartsAt: new Date(window.startsAt.getTime() - HOUR_MS),
        schedulingPeriodEndsAt: new Date(
          window.endsAt.getTime() + 30 * 24 * HOUR_MS,
        ),
      },
    });
    subscriptionId = row.id;
  }
  const appointment = await prisma.appointment.create({
    data: {
      appointmentType:
        kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
      consultationId,
      subscriptionId,
    },
  });
  const occurrence = await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      ordinal: 1,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      isTentative: shape.isTentative,
      consultantProfileId: host.consultantProfileId,
      completionStatus: shape.completionStatus ?? "SCHEDULED",
      deletedAt: shape.deletedAt ?? null,
    },
  });
  const seat =
    shape.participantStatus ?? (shape.isTentative ? "HELD" : "CONFIRMED");
  await prisma.appointmentParticipant.createMany({
    data: [
      {
        appointmentId: appointment.id,
        userId: host.userId,
        role: "CONSULTANT",
        status: seat,
      },
      {
        appointmentId: appointment.id,
        userId: consultee.userId,
        role: "CONSULTEE",
        status: seat,
      },
    ],
  });
  const payment = shape.payment
    ? await prisma.payment.create({
        data: {
          amount: price,
          originalAmount: price,
          paymentMethod: "card",
          paymentIntent: `order_dbtier_${randomUUID()}`,
          paymentGateway: "RAZORPAY",
          paymentStatus: shape.payment.status,
          userId: consultee.userId,
          appointmentId: appointment.id,
          isMockPayment: true,
          // The legs trigger needs the funding split in the same commit.
          legs: { create: [{ source: "CARD", amountPaise: price }] },
          expiresAt:
            shape.payment.expiresAt === undefined
              ? new Date(Date.now() + 30 * 60_000)
              : shape.payment.expiresAt,
        },
      })
    : null;
  return {
    appointmentId: appointment.id,
    occurrenceId: occurrence.id,
    consultationId,
    subscriptionId,
    planId,
    payment,
    /** The metadata the gateway order carries, as the capture reads it. */
    captureMetadata: {
      appointmentType:
        kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
      userId: consultee.userId,
      planId,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
    },
  };
}

/**
 * A paid subscription (by default 2 sessions a week for a month) whose first
 * cycle is not placed yet: the plan, the wrapper with both participants, and
 * a captured card payment.
 */
export async function seedPaidSubscription(
  host: SeededHost,
  subscriber: SeededConsultee,
  periodStart: Date,
  shape: {
    sessionsPerWeek?: number;
    totalSessions?: number;
    firstCycleDays?: number;
  } = {},
) {
  const { sessionsPerWeek = 2, totalSessions = 8, firstCycleDays = 30 } = shape;
  const price = BigInt(400_000);
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Database tier subscription",
      price,
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions,
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestedById: subscriber.consulteeProfileId,
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: periodStart,
      schedulingPeriodEndsAt: new Date(
        periodStart.getTime() + firstCycleDays * 24 * HOUR_MS,
      ),
      planEndsAt: new Date(periodStart.getTime() + 30 * 24 * HOUR_MS),
      schedulingTimezone: "UTC",
      sessionsTotal: totalSessions,
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  await prisma.appointmentParticipant.createMany({
    data: [
      {
        appointmentId: appointment.id,
        userId: host.userId,
        role: "CONSULTANT",
        status: "CONFIRMED",
      },
      {
        appointmentId: appointment.id,
        userId: subscriber.userId,
        role: "CONSULTEE",
        status: "CONFIRMED",
      },
    ],
  });
  await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: subscriber.userId,
      appointmentId: appointment.id,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  return { subscriptionId: subscription.id, appointmentId: appointment.id };
}

/**
 * No two live, occupying rows of one host profile overlap — the invariant every
 * race test ends on (tentative holds included, unlike the exclusion constraint).
 */
export async function overlappingOccupyingPairs(
  consultantProfileId: string,
): Promise<number> {
  const [{ pairs }] = await prisma.$queryRaw<{ pairs: number }[]>(Prisma.sql`
    SELECT count(*)::int AS pairs
    FROM "AppointmentOccurrence" a
    JOIN "AppointmentOccurrence" b
      ON a."consultantProfileId" = b."consultantProfileId"
     AND a.id < b.id
     AND tstzrange(a."startsAt", a."endsAt") && tstzrange(b."startsAt", b."endsAt")
    WHERE a."consultantProfileId" = ${consultantProfileId}
      AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
      AND a."hostCancelledAt" IS NULL AND b."hostCancelledAt" IS NULL
      AND a."completionStatus" <> 'CANCELLED' AND b."completionStatus" <> 'CANCELLED'`);
  return pairs;
}

/**
 * A one-shot gate: `pauseAfter` parks the first call of a function after its
 * real work, until the test opens the gate.
 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    /** Resolves once the paused racer has done its work and parked. */
    arrived,
    open,
    async park() {
      reached();
      await opened;
    },
  };
}

/**
 * Resolves once some backend is waiting on a lock, so a racer is provably
 * parked behind the other's row lock; throws if none ever waits.
 */
export async function untilLockWaiter(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
      Prisma.sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`,
    );
    if (waiting > 0) return;
    if (Date.now() > deadline) {
      throw new Error("No backend waited on a lock: the race never blocked");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
