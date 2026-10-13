import type { Tx } from "@/lib/prisma";

/** One plan whose collaborator row left PENDING/ACCEPTED; phase 2 revokes it. */
export interface CollaborationRef {
  collaboratorId?: string;
  planType: "webinar" | "class";
  planId: string;
  planTitle?: string;
  hostUserId?: string | null;
  collaboratorName?: string;
  role?: string;
  revenueShareBps?: number;
}

/**
 * Transitions active PENDING/ACCEPTED collaborator rows for `targetUserId` to
 * REMOVED, cancels their future collaborator participant rows, and returns plan
 * metadata for post-commit Stream revocation and host notifications.
 */
export async function removeCollaboratorStanding(
  tx: Tx,
  targetUserId: string,
): Promise<CollaborationRef[]> {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { name: true, consultantProfileId: true },
  });
  if (!target?.consultantProfileId) return [];

  const now = new Date();
  const rows = await tx.collaborator.updateManyAndReturn({
    where: {
      consultantProfileId: target.consultantProfileId,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    data: { status: "REMOVED", respondedAt: now },
    select: {
      id: true,
      collaboratorType: true,
      webinarPlanId: true,
      classPlanId: true,
      role: true,
      revenueShareBps: true,
      webinarPlan: {
        select: {
          title: true,
          consultantProfile: { select: { userId: true } },
        },
      },
      classPlan: {
        select: {
          title: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];

  if (tx.appointmentParticipant) {
    await tx.appointmentParticipant.updateMany({
      where: {
        userId: targetUserId,
        role: "COLLABORATOR",
        status: { not: "CANCELLED" },
        appointment: {
          deletedAt: null,
          occurrences: {
            some: {
              deletedAt: null,
              startsAt: { gt: now },
            },
          },
        },
      },
      data: { status: "CANCELLED" },
    });
  }

  return rows.flatMap((row) => {
    const planId =
      row.collaboratorType === "WEBINAR" ? row.webinarPlanId : row.classPlanId;
    if (!planId) return [];
    const planType = row.collaboratorType === "WEBINAR" ? "webinar" : "class";
    if (!row.id) {
      return [{ planType, planId }];
    }
    const plan =
      row.collaboratorType === "WEBINAR" ? row.webinarPlan : row.classPlan;
    return [
      {
        collaboratorId: row.id,
        planType,
        planId,
        planTitle:
          plan?.title ??
          (planType === "webinar" ? "Untitled webinar" : "Untitled class"),
        hostUserId: plan?.consultantProfile?.userId ?? null,
        collaboratorName: target.name ?? "Collaborator",
        role: row.role,
        revenueShareBps: row.revenueShareBps,
      },
    ];
  });
}
