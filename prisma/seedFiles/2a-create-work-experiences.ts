import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  sanitizeString,
  generateCompanyName,
  getCompanyDomain,
  generateJobTitle,
  generateCity,
  generateCountry,
} from "./utils";

/**
 * Create work experiences for consultants
 * Should be called after users are created
 */
export async function createWorkExperiences(
  consultants: UserWithProfiles[],
): Promise<void> {
  console.log(
    `Creating work experiences for ${consultants.length} consultants...`,
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

      // Create 2-5 work experiences per consultant
      const numExperiences = faker.number.int({ min: 2, max: 5 });
      let currentYear = new Date().getFullYear();

      for (let j = 0; j < numExperiences; j++) {
        const isCurrent = j === 0;
        const yearsInRole = faker.number.int({ min: 1, max: 5 });
        const endYear = isCurrent ? null : currentYear;
        const startYear = (endYear || currentYear) - yearsInRole;

        const startDate = new Date(
          startYear,
          faker.number.int({ min: 0, max: 11 }),
          1,
        );
        const endDate = endYear
          ? new Date(endYear, faker.number.int({ min: 0, max: 11 }), 28)
          : null;

        const companyName = generateCompanyName();
        await prisma.workExperience.create({
          data: {
            userId: consultant.id,
            company: companyName,
            companyDomain: getCompanyDomain(companyName),
            title: generateJobTitle(domainName),
            location: `${generateCity(generateCountry())}, ${generateCountry()}`,
            startDate,
            endDate,
            isCurrent,
            description: sanitizeString(faker.lorem.paragraph()),
          },
        });

        currentYear = startYear;
      }
    } catch (error) {
      console.error(
        `Failed to create work experiences for consultant ${consultant.id}:`,
        error,
      );
    }
  }
  console.log("Finished creating work experiences");
}
