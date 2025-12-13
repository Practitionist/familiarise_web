import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  generateInstitution,
  generateDegree,
} from "./utils";

/**
 * Create education history for consultees
 * Should be called after users are created
 */
export async function createConsulteeEducation(
  consultees: UserWithProfiles[]
): Promise<void> {
  console.log(
    `Creating education history for ${consultees.length} consultees...`
  );

  for (const consultee of consultees) {
    if (!consultee.consulteeProfile) continue;

    try {
      // Create 1-2 education records per consultee
      const numEducation = faker.number.int({ min: 1, max: 2 });
      let currentEndYear = new Date().getFullYear();

      // Adjust based on career stage
      const profile = await prisma.consulteeProfile.findUnique({
        where: { id: consultee.consulteeProfile.id },
      });

      if (profile?.careerStage === "STUDENT") {
        currentEndYear = new Date().getFullYear() + faker.number.int({ min: 1, max: 3 });
      } else if (profile?.careerStage === "EARLY_CAREER") {
        currentEndYear = new Date().getFullYear() - faker.number.int({ min: 0, max: 3 });
      } else {
        currentEndYear = new Date().getFullYear() - faker.number.int({ min: 3, max: 15 });
      }

      for (let j = 0; j < numEducation; j++) {
        const yearsToComplete = faker.number.int({ min: 2, max: 4 });
        const endYear = currentEndYear;
        const startYear = endYear - yearsToComplete;

        // Pick a generic field of study
        const fields = [
          "Computer Science",
          "Business Administration",
          "Engineering",
          "Marketing",
          "Economics",
          "Psychology",
          "Communications",
          "Data Science",
          "Finance",
          "Design",
        ];

        await prisma.education.create({
          data: {
            consulteeProfileId: consultee.consulteeProfile.id,
            institution: generateInstitution(),
            degree: generateDegree(),
            fieldOfStudy: faker.helpers.arrayElement(fields),
            startYear,
            endYear: profile?.careerStage === "STUDENT" && j === 0 ? null : endYear,
            grade: faker.datatype.boolean({ probability: 0.5 })
              ? faker.helpers.arrayElement([
                  "3.3 GPA",
                  "3.5 GPA",
                  "3.7 GPA",
                  "3.9 GPA",
                  "Second Class Upper",
                  "First Class",
                ])
              : null,
            activities: faker.datatype.boolean({ probability: 0.3 })
              ? faker.helpers.arrayElement([
                  "Student Club Member",
                  "Part-time Work",
                  "Internship Participant",
                  "Research Project",
                ])
              : null,
            description: null,
          },
        });

        currentEndYear = startYear - 2;
      }
    } catch (error) {
      console.error(
        `Failed to create education for consultee ${consultee.id}:`,
        error
      );
    }
  }
  console.log("Finished creating consultee education history");
}
