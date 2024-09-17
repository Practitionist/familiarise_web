import { UserWithProfiles } from "./createUsers";
import prisma from "../../lib/prisma";
import { faker } from "@faker-js/faker";

export async function createConsultationPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating consultation plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.consultationPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 0.5, // 30 minutes
            price: faker.number.int({ min: 2000, max: 5000 }), // $20 to $50
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 1, // 1 hour
            price: faker.number.int({ min: 4000, max: 10000 }), // $40 to $100
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInHours: 2, // 2 hours
            price: faker.number.int({ min: 7500, max: 20000 }), // $75 to $200
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create consultation plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created consultation plans for ${i + 1} consultants`);
    }
  }
}