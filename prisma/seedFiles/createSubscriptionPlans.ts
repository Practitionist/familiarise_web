import { faker } from "@faker-js/faker";
import { PlanEmailSupport } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createSubscriptionPlans(consultants: UserWithProfiles[]) {
  console.log(
    `Creating subscription plans for ${consultants.length} consultants...`,
  );
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
            title: "Basic Subscription",
            description: faker.lorem.paragraph(),
            durationInMonths: 1,
            price: faker.number.int({ min: 9900, max: 19900 }), // $99 to $199
            callsPerWeek: 1,
            sessionDurationInHours: 1.0,
            videoMeetings: 1,
            emailSupport: PlanEmailSupport.GENERAL,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: "Beginner",
            prerequisites: "None",
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Understand basic concepts",
                "Gain practical skills",
                "Improve problem-solving abilities",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Standard Subscription",
            description: faker.lorem.paragraph(),
            durationInMonths: 3,
            price: faker.number.int({ min: 24900, max: 49900 }), // $249 to $499
            callsPerWeek: 2,
            sessionDurationInHours: 1.0,
            videoMeetings: 2,
            emailSupport: PlanEmailSupport.PRIORITY,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: "Intermediate",
            prerequisites: faker.lorem.sentence(),
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Master advanced techniques",
                "Develop strategic thinking",
                "Enhance decision-making skills",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Premium Subscription",
            description: faker.lorem.paragraph(),
            durationInMonths: 6,
            price: faker.number.int({ min: 39900, max: 79900 }), // $399 to $799
            callsPerWeek: 3,
            sessionDurationInHours: 1.0,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.DEDICATED,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: "Advanced",
            prerequisites: faker.lorem.sentence(),
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(
              [
                "Develop expertise in the field",
                "Create comprehensive strategies",
                "Implement best practices",
              ],
              { min: 1, max: 3 },
            ),
          },
        ],
      });
    } catch (error) {
      console.error(
        `Failed to create subscription plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created subscription plans for ${i + 1} consultants`);
    }
  }
}
