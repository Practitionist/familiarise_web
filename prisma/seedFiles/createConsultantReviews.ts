import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createConsultantReviews(consultants: UserWithProfiles[], consultees: UserWithProfiles[]) {
  console.log(`Creating consultant reviews...`);
  let totalReviews = 0;
  for (const consultant of consultants) {
    if (!consultant.consultantProfile) continue;

    const numReviews = faker.number.int({ min: 1, max: 5 });
    for (let i = 0; i < numReviews; i++) {
      const consultee = faker.helpers.arrayElement(consultees);
      if (!consultee.consulteeProfile) continue;

      try {
        await prisma.consultantReview.create({
          data: {
            rating: faker.number.int({ min: 1, max: 5 }),
            reviewDescription: faker.lorem.paragraph(),
            consultantProfile: { connect: { id: consultant.consultantProfile.id } },
            consulteeProfile: { connect: { id: consultee.consulteeProfile.id } },
          },
        });
        totalReviews++;
      } catch (error) {
        console.error(`Failed to create review for consultant ${consultant.id}:`, error);
      }
    }
  }
  console.log(`Created ${totalReviews} consultant reviews`);
}