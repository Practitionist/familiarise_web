import { faker } from "@faker-js/faker";
import { PlanEmailSupport } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

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
            description:
              "Perfect for beginners. Get 1 call per week for 1 month to establish foundational knowledge and skills.",
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
            materialProvided: "Basic learning materials and resources",
            learningOutcomes: [
              "Understand basic concepts",
              "Gain practical skills",
              "Improve problem-solving abilities",
            ],
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Extended Subscription",
            description:
              "Comprehensive learning program with 2 calls per week for 6 months. Ideal for intermediate learners seeking deeper expertise.",
            durationInMonths: 6,
            price: faker.number.int({ min: 39900, max: 79900 }), // $399 to $799
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
            prerequisites: "Basic understanding of the subject area",
            materialProvided:
              "Comprehensive learning materials, templates, and resources",
            learningOutcomes: [
              "Master advanced techniques",
              "Develop strategic thinking",
              "Enhance decision-making skills",
              "Build practical expertise",
            ],
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Comprehensive Subscription",
            description:
              "Intensive program with 3 calls per week for 12 months. Designed for advanced learners and professionals seeking mastery.",
            durationInMonths: 12,
            price: faker.number.int({ min: 59900, max: 99900 }), // $599 to $999
            callsPerWeek: 3,
            sessionDurationInHours: 1.0,
            videoMeetings: 3,
            emailSupport: PlanEmailSupport.DEDICATED,
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: "Advanced",
            prerequisites: "Intermediate to advanced knowledge in the field",
            materialProvided:
              "Premium learning materials, exclusive templates, and personalized resources",
            learningOutcomes: [
              "Develop expertise in the field",
              "Create comprehensive strategies",
              "Implement best practices",
              "Achieve mastery level skills",
              "Build professional portfolio",
            ],
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
