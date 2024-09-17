import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";

const NUM_DISCOUNT_CODES = 10;

export async function createDiscountCodes() {
  console.log(`Creating ${NUM_DISCOUNT_CODES} discount codes...`);
  for (let i = 0; i < NUM_DISCOUNT_CODES; i++) {
    try {
      await prisma.discountCode.create({
        data: {
          code: faker.string.alphanumeric(8).toUpperCase(),
          description: faker.lorem.sentence(),
          discountType: faker.helpers.arrayElement(['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING']),
          discountValue: faker.helpers.arrayElement([
            faker.number.int({ min: 5, max: 50 }), // Percentage
            faker.number.int({ min: 500, max: 5000 }), // Fixed amount (in cents)
            0, // Free shipping
          ]),
        },
      });
    } catch (error) {
      console.error("Failed to create discount code:", error);
    }
  }
  console.log(`Created ${NUM_DISCOUNT_CODES} discount codes`);
}