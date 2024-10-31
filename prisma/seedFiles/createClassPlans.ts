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
      const topics = await prisma.topic.findMany({ take: 5 });
      
      // Create class plans with proper data structure
      const classPlans = await Promise.all([
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Beginner Class",
            description: faker.lorem.paragraph(),
            durationInMonths: 1,
            price: faker.number.int({ min: 19900, max: 39900 }), // $199 to $399
            callsPerWeek: 1,
            videoMeetings: 4,
            emailSupport: PlanEmailSupport.GENERAL,
            maxParticipants: faker.number.int({ min: 5, max: 15 }),
            language: faker.helpers.arrayElement(["English", "Spanish", "French", "German", "Chinese"]),
            level: "Beginner",
            prerequisites: "None",
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(["Understand basic concepts", "Gain practical skills", "Improve problem-solving abilities"], { min: 1, max: 3 }),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers.arrayElements(topics, { min: 1, max: 3 }).map(topic => ({ id: topic.id })),
            },
            classContents: {
              create: Array.from({ length: faker.number.int({ min: 3, max: 6 }) }, (_, index) => ({
                title: faker.lorem.words(3),
                description: faker.lorem.paragraph(),
                contentType: faker.helpers.arrayElement(["Video", "Text", "Quiz", "Assignment"]),
                contentUrl: faker.internet.url(),
                order: index + 1,
                hoursAllotted: faker.number.float({ min: 1, max: 5, multipleOf: 0.5 }),
              })),
            },
          },
        }),
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Intermediate Class",
            description: faker.lorem.paragraph(),
            durationInMonths: 3,
            price: faker.number.int({ min: 34900, max: 69900 }), // $349 to $699
            callsPerWeek: 2,
            videoMeetings: 8,
            emailSupport: PlanEmailSupport.PRIORITY,
            maxParticipants: faker.number.int({ min: 5, max: 12 }),
            language: faker.helpers.arrayElement(["English", "Spanish", "French", "German", "Chinese"]),
            level: "Intermediate",
            prerequisites: faker.lorem.sentence(),
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(["Master advanced techniques", "Develop strategic thinking", "Enhance decision-making skills"], { min: 1, max: 3 }),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers.arrayElements(topics, { min: 1, max: 3 }).map(topic => ({ id: topic.id })),
            },
            classContents: {
              create: Array.from({ length: faker.number.int({ min: 4, max: 8 }) }, (_, index) => ({
                title: faker.lorem.words(3),
                description: faker.lorem.paragraph(),
                contentType: faker.helpers.arrayElement(["Video", "Text", "Quiz", "Assignment"]),
                contentUrl: faker.internet.url(),
                order: index + 1,
                hoursAllotted: faker.number.float({ min: 1, max: 5, multipleOf: 0.5 }),
              })),
            },
          },
        }),
        prisma.classPlan.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: "Advanced Class",
            description: faker.lorem.paragraph(),
            durationInMonths: 6,
            price: faker.number.int({ min: 49900, max: 99900 }), // $499 to $999
            callsPerWeek: 3,
            videoMeetings: 12,
            emailSupport: PlanEmailSupport.DEDICATED,
            maxParticipants: faker.number.int({ min: 3, max: 10 }),
            language: faker.helpers.arrayElement(["English", "Spanish", "French", "German", "Chinese"]),
            level: "Advanced",
            prerequisites: faker.lorem.sentence(),
            materialProvided: faker.lorem.sentence(),
            learningOutcomes: faker.helpers.arrayElements(["Develop expertise in the field", "Create comprehensive strategies", "Implement best practices"], { min: 1, max: 3 }),
            certificateProvided: faker.datatype.boolean(),
            topics: {
              connect: faker.helpers.arrayElements(topics, { min: 1, max: 3 }).map(topic => ({ id: topic.id })),
            },
            classContents: {
              create: Array.from({ length: faker.number.int({ min: 5, max: 10 }) }, (_, index) => ({
                title: faker.lorem.words(3),
                description: faker.lorem.paragraph(),
                contentType: faker.helpers.arrayElement(["Video", "Text", "Quiz", "Assignment"]),
                contentUrl: faker.internet.url(),
                order: index + 1,
                hoursAllotted: faker.number.float({ min: 1, max: 5, multipleOf: 0.5 }),
              })),
            },
          },
        }),
      ]);
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
