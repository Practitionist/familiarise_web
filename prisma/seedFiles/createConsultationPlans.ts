import { UserWithProfiles } from "./createUsers";
import prisma from "../../lib/prisma";
import { faker } from "@faker-js/faker";

export async function createConsultationPlans(consultants: UserWithProfiles[]) {
  console.log(
    `Creating consultation plans for ${consultants.length} consultants...`,
  );
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
            title: "Basic Consultation",
            description: faker.lorem.paragraph(),
            durationInHours: 1,
            price: faker.number.int({ min: 2000, max: 5000 }), // $20 to $50
            priceCurrency: "INR",
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: faker.helpers.arrayElement([
              "Beginner",
              "Intermediate",
              "Advanced",
            ]),
            prerequisites: faker.lorem.sentence(),
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
            title: "Extended Consultation",
            description: faker.lorem.paragraph(),
            durationInHours: 2,
            price: faker.number.int({ min: 4000, max: 10000 }), // $40 to $100
            priceCurrency: "INR",
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: faker.helpers.arrayElement([
              "Beginner",
              "Intermediate",
              "Advanced",
            ]),
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
            title: "Comprehensive Consultation",
            description: faker.lorem.paragraph(),
            durationInHours: 4,
            price: faker.number.int({ min: 7500, max: 20000 }), // $75 to $200
            priceCurrency: "INR",
            language: faker.helpers.arrayElement([
              "English",
              "Spanish",
              "French",
              "German",
              "Chinese",
            ]),
            level: faker.helpers.arrayElement(["Intermediate", "Advanced"]),
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
        `Failed to create consultation plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created consultation plans for ${i + 1} consultants`);
    }
  }
}
