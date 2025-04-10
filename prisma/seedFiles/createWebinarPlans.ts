import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./createUsers";

export async function createWebinarPlans(consultants: UserWithProfiles[]) {
  console.log(
    `Creating webinar plans for ${consultants.length} consultants...`,
  );
  for (let i = 0; i < consultants.length; i++) {
    const consultant = consultants[i];
    if (!consultant.consultantProfile) {
      console.warn(`Skipping consultant ${consultant.id} - no profile found`);
      continue;
    }
    try {
      const topics = await prisma.topic.findMany({ take: 5 });
      await prisma.webinarPlan.createMany({
        data: [
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Introduction Webinar",
            description: faker.lorem.paragraph(),
            priceCurrency: "INR",
            certificateProvided: false,
            durationInHours: 1,
            price: faker.number.int({ min: 1500, max: 3000 }), // $15 to $30
            maxParticipants: faker.number.int({ min: 20, max: 50 }),
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
                "Gain practical insights",
                "Learn industry trends",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Advanced Topics Webinar",
            description: faker.lorem.paragraph(),
            priceCurrency: "INR",
            certificateProvided: false,
            durationInHours: 2,
            price: faker.number.int({ min: 2500, max: 5000 }), // $25 to $50
            maxParticipants: faker.number.int({ min: 15, max: 40 }),
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
                "Enhance problem-solving skills",
              ],
              { min: 1, max: 3 },
            ),
          },
          {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Expert Workshop Webinar",
            description: faker.lorem.paragraph(),
            priceCurrency: "INR",
            certificateProvided: false,
            durationInHours: 3,
            price: faker.number.int({ min: 3500, max: 7000 }), // $35 to $70
            maxParticipants: faker.number.int({ min: 10, max: 30 }),
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

      // Add topics to each webinar plan
      const webinarPlans = await prisma.webinarPlan.findMany({
        where: { consultantProfileId: consultant.consultantProfile.id },
      });

      for (const plan of webinarPlans) {
        await prisma.webinarPlan.update({
          where: { id: plan.id },
          data: {
            topics: {
              connect: faker.helpers
                .arrayElements(topics, { min: 1, max: 3 })
                .map((topic) => ({ id: topic.id })),
            },
          },
        });
      }
    } catch (error) {
      console.error(
        `Failed to create webinar plans for consultant ${consultant.id}:`,
        error,
      );
    }
    if ((i + 1) % 10 === 0 || i === consultants.length - 1) {
      console.log(`Created webinar plans for ${i + 1} consultants`);
    }
  }
}
