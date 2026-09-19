import { faker } from "@faker-js/faker";
import {
  Currency,
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
 * a seeded PENDING row has no expiresAt and no tentative hold, so no sweep can
 * ever retire it and reconcile-payment-status re-reports its fake gateway id
 * on every tick (FAMILIARISE_WEB-4P). A real PENDING row only exists mid-checkout.
 */
export const SEED_PAYMENT_STATUS_WEIGHTS = [
  { value: PaymentStatus.SUCCEEDED, weight: 0.75 },
  { value: PaymentStatus.FAILED, weight: 0.15 },
  { value: PaymentStatus.EXPIRED, weight: 0.1 },
];

/**
 * #1757 — a SUCCEEDED payment funds itself with one CARD leg equal to its
 * amount, the same leg-sum identity production writes hold to
 * (`payment_legs_sum_to_amount`). Nothing else carries a leg: a FAILED or
 * EXPIRED row never collected, and a zero-amount row has nothing to fund.
 */
export function buildSeedPaymentLegs(
  status: PaymentStatus,
  amountPaise: number,
): Prisma.PaymentLegCreateWithoutPaymentInput[] {
  if (status !== PaymentStatus.SUCCEEDED || amountPaise <= 0) return [];
  return [{ source: PaymentLegSource.CARD, amountPaise }];
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

  for (let i = 0; i < appointments.length; i++) {
    const user = faker.helpers.arrayElement(users);
    const appointment = appointments[i];

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

      const paymentStatus = weightedRandom(SEED_PAYMENT_STATUS_WEIGHTS);
      const legs = buildSeedPaymentLegs(paymentStatus, finalAmount);
      const paymentData: Prisma.PaymentCreateInput = {
        user: { connect: { id: user.id } },
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
        paymentIntent: faker.string.uuid(),
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
      // #1319 A9 — stamp the funding payment on the buyer's participant row.
      await prisma.appointmentParticipant.updateMany({
        where: {
          appointmentId: appointment.id,
          userId: user.id,
          paymentId: null,
        },
        data: { paymentId: created.id },
      });
    } catch (error) {
      console.error(
        `Failed to create payment for user ${user.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if ((i + 1) % 20 === 0 || i === appointments.length - 1) {
      console.log(`Created ${i + 1} payments`);
    }
  }

  console.log(`Finished creating payments`);
}
