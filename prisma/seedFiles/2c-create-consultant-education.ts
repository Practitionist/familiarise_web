import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  sanitizeString,
  generateInstitution,
  generateDegree,
  generateFieldOfStudy,
} from "./utils";

/**
 * Create education records for consultants
 * Should be called after users are created
 */
export async function createConsultantEducation(
  consultants: UserWithProfiles[]
): Promise<void> {
  console.log(
    `Creating education records for ${consultants.length} consultants...`
  );

  for (const consultant of consultants) {
    if (!consultant.consultantProfile) continue;

    try {
      // Get domain for this consultant
      const profile = await prisma.consultantProfile.findUnique({
        where: { id: consultant.consultantProfile.id },
        include: { domain: true },
      });

      const domainName = profile?.domain?.name || "Technology";

      // Create 1-3 education records per consultant
      const numEducation = faker.number.int({ min: 1, max: 3 });
      let currentEndYear = new Date().getFullYear() - 2;

      for (let j = 0; j < numEducation; j++) {
        const yearsToComplete = faker.number.int({ min: 2, max: 4 });
        const endYear = currentEndYear;
        const startYear = endYear - yearsToComplete;

        await prisma.education.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            institution: generateInstitution(),
            degree: generateDegree(),
            fieldOfStudy: generateFieldOfStudy(domainName),
            startYear,
            endYear,
            grade: faker.datatype.boolean({ probability: 0.6 })
              ? faker.helpers.arrayElement([
                  "3.5 GPA",
                  "3.7 GPA",
                  "3.9 GPA",
                  "4.0 GPA",
                  "First Class",
                  "Distinction",
                  "Magna Cum Laude",
                  "Summa Cum Laude",
                ])
              : null,
            activities: faker.datatype.boolean({ probability: 0.4 })
              ? faker.helpers.arrayElement([
                  "Student Government, Research Assistant",
                  "Teaching Assistant, Hackathon Organizer",
                  "Sports Team Captain, Debate Club",
                  "Honor Society, Volunteer Coordinator",
                ])
              : null,
            description: faker.datatype.boolean({ probability: 0.3 })
              ? sanitizeString(faker.lorem.sentence())
              : null,
          },
        });

        currentEndYear = startYear - 1;
      }
    } catch (error) {
      console.error(
        `Failed to create education for consultant ${consultant.id}:`,
        error
      );
    }
  }
  console.log("Finished creating consultant education records");
}
