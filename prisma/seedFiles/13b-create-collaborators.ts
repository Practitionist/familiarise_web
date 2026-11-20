import { faker } from "@faker-js/faker";
import type { CollaboratorRole, CollaboratorStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { tierForRole } from "../../lib/collaborators/roles";

const WEBINAR_ROLES: CollaboratorRole[] = [
  "CO_HOST",
  "MODERATOR",
  "GUEST_SPEAKER",
  "TECHNICAL_SUPPORT",
];

const CLASS_ROLES: CollaboratorRole[] = [
  "CO_INSTRUCTOR",
  "TEACHING_ASSISTANT",
  "GUEST_LECTURER",
  "CONTENT_CREATOR",
];

const SEEDED_STATUSES: CollaboratorStatus[] = [
  "PENDING",
  "ACCEPTED",
  "DECLINED",
];

type SeedPlan = { id: string; consultantProfileId: string | null };

/**
 * One invitation, then its answer. A row is born PENDING and the database
 * stamps the accepted and ended times on the move, so the seed takes the same
 * two steps the product does. Returns false when the plan's rules refuse the
 * row (a second presenter, a fourth collaborator, shares past 90%).
 */
async function seedCollaborator(
  planType: "WEBINAR" | "CLASS",
  plan: SeedPlan,
  consultantProfileId: string,
): Promise<boolean> {
  const role = faker.helpers.arrayElement(
    planType === "WEBINAR" ? WEBINAR_ROLES : CLASS_ROLES,
  );
  const status = faker.helpers.arrayElement(SEEDED_STATUSES);
  try {
    const invited = await prisma.collaborator.create({
      data: {
        consultantProfileId,
        collaboratorType: planType,
        ...(planType === "WEBINAR"
          ? { webinarPlanId: plan.id }
          : { classPlanId: plan.id }),
        role,
        tier: tierForRole(role),
        revenueShareBps: faker.helpers.arrayElement([
          1000, 1500, 2000, 2500, 3000,
        ]),
        invitedById: plan.consultantProfileId,
      },
      select: { id: true },
    });
    if (status !== "PENDING") {
      await prisma.collaborator.update({
        where: { id: invited.id },
        data: { status },
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Seeds one or two collaborators on half of the webinar and class plans. */
export async function createCollaborators() {
  console.log("Creating collaborators...");

  const consultantProfiles = await prisma.consultantProfile.findMany({
    select: { id: true },
    take: 30,
  });

  if (consultantProfiles.length < 3) {
    console.log("Not enough consultant profiles. Skipping collaborators.");
    return;
  }

  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      select: { id: true, consultantProfileId: true },
      take: 10,
    }),
    prisma.classPlan.findMany({
      select: { id: true, consultantProfileId: true },
      take: 10,
    }),
  ]);

  const created = { WEBINAR: 0, CLASS: 0 };
  const batches = [
    { planType: "WEBINAR" as const, plans: webinarPlans },
    { planType: "CLASS" as const, plans: classPlans },
  ];

  for (const { planType, plans } of batches) {
    for (const plan of plans.slice(0, Math.ceil(plans.length * 0.5))) {
      const others = consultantProfiles.filter(
        (profile) => profile.id !== plan.consultantProfileId,
      );
      const invitees = faker.helpers
        .shuffle(others)
        .slice(0, faker.number.int({ min: 1, max: 2 }));
      for (const invitee of invitees) {
        if (await seedCollaborator(planType, plan, invitee.id)) {
          created[planType]++;
        }
      }
    }
  }

  console.log(
    `Created ${created.WEBINAR} webinar collaborators, ${created.CLASS} class collaborators`,
  );
}
