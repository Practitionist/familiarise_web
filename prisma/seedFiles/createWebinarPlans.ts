import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createWebinarPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating webinar plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.webinarPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 1, // 1 hour
            price: faker.number.int({ min: 1500, max: 3000 }), // $15 to $30
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 2, // 2 hours
            price: faker.number.int({ min: 2500, max: 5000 }), // $25 to $50
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 3, // 3 hours
            price: faker.number.int({ min: 3500, max: 7000 }), // $35 to $70
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create webinar plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created webinar plans for ${i + 1} consultants`);
    }
  }
}