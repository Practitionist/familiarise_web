import { faker } from "@faker-js/faker";
import { DiscountType } from "@prisma/client";
import prisma from "../../lib/prisma";

const NUM_DISCOUNT_CODES = 10;

export async function createDiscountCodes() {
  console.log(`Creating ${NUM_DISCOUNT_CODES} discount codes...`);
  for (let i = 0; i < NUM_DISCOUNT_CODES; i++) {
    try {
      const discountType = faker.helpers.arrayElement(Object.values(DiscountType));
      let discountValue: number;

      switch (discountType) {
        case DiscountType.PERCENTAGE:
          discountValue = faker.number.int({ min: 5, max: 50 });
          break;
        case DiscountType.FIXED_AMOUNT:
          discountValue = faker.number.int({ min: 500, max: 5000 }); // Fixed amount in cents
          break;
        case DiscountType.FREE_SHIPPING:
          discountValue = 0;
          break;
      }

      await prisma.discountCode.create({
        data: {
          code: faker.string.alphanumeric(8).toUpperCase(),
          description: faker.lorem.sentence(),
          discountType: discountType,
          discountValue: discountValue,
        },
      });
    } catch (error) {
      console.error("Failed to create discount code:", error);
    }
  }
  console.log(`Created ${NUM_DISCOUNT_CODES} discount codes`);
}