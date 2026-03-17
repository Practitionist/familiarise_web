import { faker } from "@faker-js/faker";
import { AchievementType } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

const ACHIEVEMENT_TEMPLATES: {
  title: string;
  type: AchievementType;
  urlTemplate?: string;
}[] = [
  {
    title: "Published in IEEE Conference",
    type: "PUBLICATION",
    urlTemplate: "https://ieeexplore.ieee.org/document/",
  },
  {
    title: "Open Source Contributor - 1000+ Stars",
    type: "OPEN_SOURCE",
    urlTemplate: "https://github.com/",
  },
  {
    title: "Speaker at React Summit",
    type: "TALK",
    urlTemplate: "https://reactsummit.com/speakers/",
  },
  {
    title: "AWS Solutions Architect Award",
    type: "AWARD",
  },
  {
    title: "Built a SaaS with 10K+ Users",
    type: "PROJECT",
    urlTemplate: "https://",
  },
  {
    title: "Google Developer Expert",
    type: "AWARD",
  },
  {
    title: "Published Technical Blog - 50K+ Readers",
    type: "PUBLICATION",
    urlTemplate: "https://medium.com/@",
  },
  {
    title: "Hackathon Winner - ETHGlobal",
    type: "AWARD",
  },
  {
    title: "Conference Speaker - PyCon",
    type: "TALK",
  },
  {
    title: "Open Source Maintainer - npm 100K+ Downloads",
    type: "OPEN_SOURCE",
    urlTemplate: "https://www.npmjs.com/package/",
  },
];

/**
 * Create achievements for consultant profiles
 * Should be called after users and consultant profiles are created
 */
export async function createAchievements(
  consultants: UserWithProfiles[],
): Promise<void> {
  console.log(
    `Creating achievements for ${consultants.length} consultants...`,
  );

  for (const consultant of consultants) {
    if (!consultant.consultantProfile) continue;

    try {
      const numAchievements = faker.number.int({ min: 1, max: 3 });
      const selectedTemplates = faker.helpers.arrayElements(
        ACHIEVEMENT_TEMPLATES,
        numAchievements,
      );

      for (const template of selectedTemplates) {
        await prisma.achievement.create({
          data: {
            consultantProfileId: consultant.consultantProfile.id,
            title: template.title,
            description: faker.lorem.sentence(),
            url: template.urlTemplate
              ? `${template.urlTemplate}${faker.string.alphanumeric(8)}`
              : null,
            achievementType: template.type,
          },
        });
      }
    } catch (error) {
      console.error(
        `Failed to create achievements for consultant ${consultant.id}:`,
        error,
      );
    }
  }
  console.log("Finished creating achievements");
}
