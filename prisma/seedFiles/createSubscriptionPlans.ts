import { faker } from "@faker-js/faker";
import { PlanEmailSupport } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createSubscriptionPlans(consultants: UserWithProfiles[]) {
  console.log(`Creating subscription plans for ${consultants.length} consultants...`);
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      await prisma.subscriptionPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 1,
            price: faker.number.int({ min: 9900, max: 19900 }), // $99 to $199
            callsPerWeek: 1,
            videoMeetings: 1,
            emailSupport: PlanEmailSupport.GENERAL,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 3,
            price: faker.number.int({ min: 24900, max: 49900 }), // $249 to $499
            callsPerWeek: 2,
            videoMeetings: 2,
            emailSupport: PlanEmailSupport.PRIORITY,
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            durationInMonths: 6,
            price: faker.number.int({ min: 39900, max: 79900 }), // $399 to $799
            callsPerWeek: 3,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.DEDICATED,
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create subscription plans for consultant ${consultant.id}:`,
        error
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created subscription plans for ${i + 1} consultants`);
    }
  }
}