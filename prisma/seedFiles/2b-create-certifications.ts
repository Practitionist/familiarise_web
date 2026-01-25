import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import {
  generateCertificationName,
  generateIssuingOrganization,
} from "./utils";

/**
 * Create certifications for consultants
 * Should be called after users are created
 */
export async function createCertifications(
  consultants: UserWithProfiles[],
): Promise<void> {
  console.log(
    `Creating certifications for ${consultants.length} consultants...`,
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

      // Create 1-4 certifications per consultant
      const numCerts = faker.number.int({ min: 1, max: 4 });

      for (let j = 0; j < numCerts; j++) {
        const certName = generateCertificationName(domainName);
        const issueDate = faker.date.past({ years: 5 });
        const hasExpiry = faker.datatype.boolean({ probability: 0.4 });
        const expiryDate = hasExpiry
          ? new Date(
              issueDate.getFullYear() + faker.number.int({ min: 2, max: 5 }),
              issueDate.getMonth(),
              issueDate.getDate(),
            )
          : null;

        await prisma.certification.create({
          data: {
            userId: consultant.id,
            name: certName,
            issuingOrganization: generateIssuingOrganization(certName),
            issueDate,
            expiryDate,
            credentialId: faker.datatype.boolean({ probability: 0.7 })
              ? faker.string.alphanumeric(12).toUpperCase()
              : null,
            credentialUrl: faker.datatype.boolean({ probability: 0.5 })
              ? faker.internet.url()
              : null,
          },
        });
      }
    } catch (error) {
      console.error(
        `Failed to create certifications for consultant ${consultant.id}:`,
        error,
      );
    }
  }
  console.log("Finished creating certifications");
}
