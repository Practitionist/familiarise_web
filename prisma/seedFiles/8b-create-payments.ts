import { faker } from "@faker-js/faker";
import {
  Currency,
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
  PaymentGateway,
  PaymentLegSource,
  PaymentStatus,
  Prisma,
  DiscountType,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import { config } from "./config";
import { weightedRandom } from "./utils";

/**
 * #1757 — statuses a seeded payment may take. PENDING is deliberately absent:
 * a random PENDING row has no expiresAt and no tentative hold, so no sweep can
 * ever retire it and reconcile-payment-status re-reports its fake gateway id
 * on every tick (FAMILIARISE_WEB-4P). A real PENDING row only exists mid-checkout,
 * which is how 6a seeds one: beside its tentative hold, with expiresAt.
 */
export const SEED_PAYMENT_STATUS_WEIGHTS = [
  { value: PaymentStatus.SUCCEEDED, weight: 0.75 },
  { value: PaymentStatus.FAILED, weight: 0.15 },
  { value: PaymentStatus.EXPIRED, weight: 0.1 },
];

/**
 * #1757 — a payment funds itself with one CARD leg equal to its amount, the
 * leg-sum identity `payment_legs_sum_to_amount` enforces on every Payment
 * insert. Checkout writes the leg at order mint, so a FAILED or EXPIRED row
 * keeps it; only a zero-amount row has nothing to fund.
 */
export function buildSeedPaymentLegs(
  amountPaise: number,
  sourceRef: string,
): Prisma.PaymentLegCreateWithoutPaymentInput[] {
  if (amountPaise <= 0) return [];
  return [{ source: PaymentLegSource.CARD, amountPaise, sourceRef }];
}

/** A plan is paid at purchase by its requester, so an approved subscription's row is their SUCCEEDED payment. */
export function seedPaymentOutcome(
  appointment: { subscription: { requestedBy: { userId: string } } | null },
  drawnUserId: string,
): { userId: string; paymentStatus: PaymentStatus } {
  if (appointment.subscription) {
    return {
      userId: appointment.subscription.requestedBy.userId,
      paymentStatus: PaymentStatus.SUCCEEDED,
    };
  }
  return {
    userId: drawnUserId,
    paymentStatus: weightedRandom(SEED_PAYMENT_STATUS_WEIGHTS),
  };
}

// Payment volume - configurable via SEED_MODE environment variable
const NUM_PAYMENTS = config.volumes.payments;

export async function createPayments(users: UserWithProfiles[]) {
  console.log(`Creating payments...`);
  const discountCodes = await prisma.discountCode.findMany();
  const appointments = await prisma.appointment.findMany({
    where: {
      payment: {
        none: {},
      },
      OR: [
        { consultation: { status: "APPROVED" } },
        { subscription: { status: "APPROVED" } },
        { webinar: { status: "SCHEDULED" } },
        { class: { status: "SCHEDULED" } },
      ],
    },
    include: {
      consultation: {
        include: {
          consultationPlan: true,
        },
      },
      subscription: {
        include: {
          subscriptionPlan: true,
          requestedBy: { select: { userId: true } },
        },
      },
      webinar: {
        include: {
          webinarPlan: true,
        },
      },
      class: {
        include: {
          classPlan: true,
        },
      },
    },
    take: NUM_PAYMENTS,
  });

  const paidAppointmentIds: string[] = [];
  for (let i = 0; i < appointments.length; i++) {
    const appointment = appointments[i];
    const { userId, paymentStatus } = seedPaymentOutcome(
      appointment,
      faker.helpers.arrayElement(users).id,
    );

    try {
      // Determine the amount based on the appointment type and plan
      let amount = 0;
      let description = "";

      if (appointment.consultation?.consultationPlan) {
        amount = appointment.consultation.consultationPlan.price;
        description = `Payment for Consultation: ${appointment.consultation.consultationPlan.title}`;
      } else if (appointment.subscription?.subscriptionPlan) {
        amount = appointment.subscription.subscriptionPlan.price;
        description = `Payment for Subscription: ${appointment.subscription.subscriptionPlan.title}`;
      } else if (appointment.webinar?.webinarPlan) {
        amount = appointment.webinar.webinarPlan.price;
        description = `Payment for Webinar: ${appointment.webinar.webinarPlan.title}`;
      } else if (appointment.class?.classPlan) {
        amount = appointment.class.classPlan.price;
        description = `Payment for Class: ${appointment.class.classPlan.title}`;
      }

      // Apply discount if available
      const useDiscount = faker.datatype.boolean() && discountCodes.length > 0;
      const discountCode = useDiscount
        ? faker.helpers.arrayElement(discountCodes)
        : null;

      let finalAmount = amount;
      if (discountCode) {
        switch (discountCode.discountType) {
          case DiscountType.PERCENTAGE:
            finalAmount = Math.round(
              amount * (1 - discountCode.discountValue / 100),
            );
            break;
          case DiscountType.FIXED_AMOUNT:
            finalAmount = Math.max(0, amount - discountCode.discountValue);
            break;
        }
      }

      const paymentIntent = faker.string.uuid();
      const legs = buildSeedPaymentLegs(finalAmount, paymentIntent);
      const paymentData: Prisma.PaymentCreateInput = {
        user: { connect: { id: userId } },
        amount: finalAmount,
        originalAmount: amount,
        // INR, like every real payment. This used to pick a random foreign
        // currency, which is why 386 of 397 seeded payments were non-INR while
        // no plan has ever been priced in anything but INR. Dashboards then
        // summed EUR + GBP + USD + INR minor units into one figure and labelled
        // it with a single symbol — the operator home page read ₹26,47,683.47
        // for a number that was four currencies added together.
        currency: Currency.INR,
        description,
        receiptUrl: faker.internet.url(),
        paymentMethod: faker.helpers.arrayElement([
          "credit_card",
          "debit_card",
          "bank_transfer",
          "wallet",
        ]),
        paymentIntent,
        paymentGateway: faker.helpers.arrayElement<PaymentGateway>(
          Object.values(PaymentGateway),
        ),
        paymentStatus,
        appointment: { connect: { id: appointment.id } },
        ...(legs.length > 0 ? { legs: { create: legs } } : {}),
        ...(discountCode
          ? { discountCode: { connect: { id: discountCode.id } } }
          : {}),
      };

      const created = await prisma.payment.create({
        data: paymentData,
      });
      if (paymentStatus === PaymentStatus.SUCCEEDED) {
        paidAppointmentIds.push(appointment.id);
      }
      // #1319 A9 — stamp the funding payment on the buyer's participant row.
      await prisma.appointmentParticipant.updateMany({
        where: {
          appointmentId: appointment.id,
          userId,
          paymentId: null,
        },
        data: { paymentId: created.id },
      });
    } catch (error) {
      console.error(
        `Failed to create payment for user ${userId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if ((i + 1) % 20 === 0 || i === appointments.length - 1) {
      console.log(`Created ${i + 1} payments`);
    }
  }

  // A past session this run paid for was held; only this run's rows, since the DB is shared.
  const now = new Date();
  const held = await prisma.appointmentOccurrence.updateMany({
    where: {
      appointmentId: { in: paidAppointmentIds },
      endsAt: { lt: now },
      isTentative: false,
      completionStatus: OccurrenceCompletionStatus.UNVERIFIED,
      outcome: null,
      deletedAt: null,
      appointment: {
        payment: {
          some: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
        },
      },
    },
    data: {
      completionStatus: OccurrenceCompletionStatus.COMPLETED,
      completedAt: now,
      outcome: OccurrenceOutcome.HELD,
      outcomeAt: now,
    },
  });
  console.log(
    `Finished creating payments; ${held.count} paid past sessions held`,
  );
}
