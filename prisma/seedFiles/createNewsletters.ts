import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";

const NUM_NEWSLETTERS = 100;

export async function createNewsletters() {
  console.log(`Creating ${NUM_NEWSLETTERS} newsletter subscriptions...`);
  for (let i = 0; i < NUM_NEWSLETTERS; i++) {
    try {
      await prisma.newsletter.create({
        data: {
          email: faker.internet.email(),
        },
      });
    } catch (error) {
      console.error("Failed to create newsletter subscription:", error);
    }
    if ((i + 1) % 20 === 0 || i === NUM_NEWSLETTERS - 1) {
      console.log(`Created ${i + 1} newsletter subscriptions`);
    }
  }
}