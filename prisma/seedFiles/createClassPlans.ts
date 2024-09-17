import { faker } from "@faker-js/faker";
import { PlanEmailSupport } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createClassPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating class plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.classPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 1,
            price: faker.number.int({ min: 19900, max: 39900 }), // $199 to $399
            callsPerWeek: 1,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 3,
            price: faker.number.int({ min: 34900, max: 69900 }), // $349 to $699
            callsPerWeek: 2,
            videoMeetings: 8,
            emailSupport: PlanEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 6,
            price: faker.number.int({ min: 49900, max: 99900 }), // $499 to $999
            callsPerWeek: 3,
            videoMeetings: 12,
            emailSupport: PlanEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create class plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created class plans for ${i + 1} consultants`);
    }
  }
}