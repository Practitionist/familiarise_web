import prisma from "@/lib/prisma";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";

export type CollabChannelAccess =
  "ok" | "collaborator" | "forbidden" | "not_found" | "org_deactivated";

/**
 * Who may hold a seat in a plan's `collab-` channel: staff, the host, an
 * ACCEPTED collaborator, or an ACTIVE member of the plan's live org with
 * `messaging.read` or `catalog.manage`. The open route and the membership
 * reconciler both decide with this, so one cannot admit whom the other removes.
 * `collaborator` is admission that rests on the collaboration alone, which the
 * open route re-checks after its grant.
 */
export async function collabChannelAccess(
  userId: string,
  userRole: string | null | undefined,
  planType: "webinar" | "class",
  planId: string,
): Promise<CollabChannelAccess> {
  const select = {
    organizationId: true,
    organization: { select: { status: true } },
    consultantProfile: { select: { userId: true } },
    collaborators: {
      where: {
        status: "ACCEPTED" as const,
        consultantProfile: { deletedAt: null },
      },
      select: { consultantProfile: { select: { userId: true } } },
    },
  };
  const plan =
    planType === "webinar"
      ? await prisma.webinarPlan.findUnique({ where: { id: planId }, select })
      : await prisma.classPlan.findUnique({ where: { id: planId }, select });
  if (!plan) return "not_found";

  if (isPrivileged(userRole)) return "ok";
  // Checked before the host and collaborator arms: a wound-down org's chat stays closed to its own members.
  if (plan.organization?.status === "DEACTIVATED") return "org_deactivated";
  if (plan.consultantProfile?.userId === userId) return "ok";
  if (plan.collaborators.some((c) => c.consultantProfile.userId === userId)) {
    return "collaborator";
  }

  if (plan.organizationId) {
    const membership = await prisma.membership.findFirst({
      where: {
        organizationId: plan.organizationId,
        userId,
        status: "ACTIVE",
        organization: { status: { not: "DEACTIVATED" } },
      },
      select: { role: true },
    });
    if (
      membership &&
      hasAnyOrgPermission(membership.role, ["messaging.read", "catalog.manage"])
    ) {
      return "ok";
    }
  }
  return "forbidden";
}
