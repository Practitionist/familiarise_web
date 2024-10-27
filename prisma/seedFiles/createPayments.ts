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
      payment: null // Only get appointments without payments
    },
    take: NUM_PAYMENTS, // Limit to the number of payments we want to create
  });

  for (let i = 0; i < appointments.length; i++) {
    const user = faker.helpers.arrayElement(users);
    const appointment = appointments[i];

    try {
      const paymentData: Prisma.PaymentCreateInput = {
        user: { connect: { id: user.id } },
        amount: faker.number.int({ min: 1000, max: 100000 }), // Amount in cents
        currency: faker.helpers.arrayElement(['USD', 'EUR', 'GBP']),
        description: faker.lorem.sentence(),
        receiptUrl: faker.internet.url(),
        paymentMethod: faker.helpers.arrayElement(['credit_card', 'paypal', 'bank_transfer']),
        paymentIntent: faker.string.uuid(),
        paymentGateway: faker.helpers.arrayElement(Object.values(PaymentGateway)),
        paymentStatus: faker.helpers.arrayElement(Object.values(PaymentStatus)),
        appointment: { connect: { id: appointment.id } },
        ...(faker.datatype.boolean() && discountCodes.length > 0
          ? { discountCode: { connect: { id: faker.helpers.arrayElement(discountCodes).id } } }
          : {})
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
