import prisma from "@/lib/prisma";
import { inviteWebinarCollaboratorSchema } from "@/schemas/collaborators";
import { createPlanCollaborationHandlers } from "@/lib/api/collaborations/plan-route";

// Webinar plan-collaboration surface. GET (list) + POST (invite) share the
// implementation with the class twin; only the plan model, the invite-role
// subset, the id field, and log labels differ (Sonar clone group, #1814).
const { GET, POST } = createPlanCollaborationHandlers({
  planKind: "webinar",
  schema: inviteWebinarCollaboratorSchema,
  fetchLogLabel: "webinar",
  inviteLogLabel: "webinar",
  findPlan: (planId) =>
    prisma.webinarPlan.findUnique({
      where: { id: planId },
      include: { consultantProfile: true },
    }),
  findExisting: (planId, consultantProfileId) =>
    prisma.collaborator.findFirst({
      where: {
        webinarPlanId: planId,
        consultantProfileId,
        status: { notIn: ["REMOVED", "DECLINED", "WITHDRAWN"] },
      },
    }),
});

export { GET, POST };
