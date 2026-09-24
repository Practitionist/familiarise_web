import prisma from "@/lib/prisma";
import { inviteClassCollaboratorSchema } from "@/schemas/collaborators";
import { createPlanCollaborationHandlers } from "@/lib/api/collaborations/plan-route";

// Class plan-collaboration surface. Mirrors the webinar twin; see it for
// the shared-implementation note (Sonar clone group, #1814).
const { GET, POST } = createPlanCollaborationHandlers({
  planKind: "class",
  schema: inviteClassCollaboratorSchema,
  fetchLogLabel: "class",
  inviteLogLabel: "class",
  findPlan: (planId) =>
    prisma.classPlan.findUnique({
      where: { id: planId },
      include: { consultantProfile: true },
    }),
  findExisting: (planId, consultantProfileId) =>
    prisma.collaborator.findFirst({
      where: {
        classPlanId: planId,
        consultantProfileId,
        status: { notIn: ["REMOVED", "DECLINED", "WITHDRAWN"] },
      },
    }),
});

export { GET, POST };
