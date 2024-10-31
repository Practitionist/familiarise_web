import { faker } from "@faker-js/faker";
import { PaymentGateway, PaymentStatus, Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

const NUM_PAYMENTS = 100;

export async function createPayments(users: UserWithProfiles[]) {
  console.log(`Creating payments...`);
  const discountCodes = await prisma.discountCode.findMany();
  const appointments = await prisma.appointment.findMany({
    where: {
      payment: null, // Only get appointments without payments
      OR: [
        { consultation: { requestStatus: "APPROVED" } },
        { subscription: { requestStatus: "APPROVED" } },
        { webinar: { status: "SCHEDULED" } },
        { class: { status: "SCHEDULED" } },
      ]
    },
    include: {
      consultation: {
        include: {
          consultationPlan: true,
        },
      },
      subscription: {
        include: {
          plan: true,
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
      if (appointment.consultation?.consultationPlan) {
        amount = appointment.consultation.consultationPlan.price;
      } else if (appointment.subscription?.plan) {
        amount = appointment.subscription.plan.price;
      } else if (appointment.webinar?.webinarPlan) {
        amount = appointment.webinar.webinarPlan.price;
      } else if (appointment.class?.classPlan) {
        amount = appointment.class.classPlan.price;
      }

      // Apply discount if available
      const useDiscount = faker.datatype.boolean() && discountCodes.length > 0;
      const discountCode = useDiscount ? faker.helpers.arrayElement(discountCodes) : null;
      if (discountCode) {
        switch (discountCode.discountType) {
          case "PERCENTAGE":
            amount = Math.round(amount * (1 - discountCode.discountValue / 100));
            break;
          case "FIXED_AMOUNT":
            amount = Math.max(0, amount - discountCode.discountValue);
            break;
          // FREE_SHIPPING doesn't affect the amount in this context
        }
      }

      const paymentData: Prisma.PaymentCreateInput = {
        user: { connect: { id: user.id } },
        amount: amount,
        currency: faker.helpers.arrayElement(['USD', 'EUR', 'GBP']),
        description: faker.lorem.sentence(),
        receiptUrl: faker.internet.url(),
        paymentMethod: faker.helpers.arrayElement(['credit_card', 'debit_card', 'bank_transfer', 'wallet']),
        paymentIntent: faker.string.uuid(),
        paymentGateway: faker.helpers.arrayElement(Object.values(PaymentGateway)),
        paymentStatus: faker.helpers.arrayElement(Object.values(PaymentStatus)),
        appointment: { connect: { id: appointment.id } },
        ...(discountCode ? { discountCode: { connect: { id: discountCode.id } } } : {})
      };

      await prisma.payment.create({ 
        data: paymentData 
      });
    } catch (error) {
      console.error(`Failed to create payment for user ${user.id}:`, error);
    }

    if ((i + 1) % 20 === 0 || i === appointments.length - 1) {
      console.log(`Created ${i + 1} payments`);
    }
  }
}
