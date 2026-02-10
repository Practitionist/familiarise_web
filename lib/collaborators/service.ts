import prisma from "@/lib/prisma";
import type {
  WebinarCollaborator,
  ClassCollaborator,
  CollaboratorStatus,
} from "@prisma/client";

type PlanType = "webinar" | "class";

const MIN_HOST_SHARE = 10; // Host must keep at least 10%

/**
 * Invite a collaborator to a webinar or class plan.
 */
export async function inviteCollaborator(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  role: string,
  revenueSharePercentage: number,
  invitedById: string,
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  // Validate revenue share total <= 90%
  const valid = await validateRevenueShares(
    planType,
    planId,
    revenueSharePercentage,
  );
  if (!valid) return null;

  if (planType === "webinar") {
    return prisma.webinarCollaborator.create({
      data: {
        consultantProfileId,
        webinarPlanId: planId,
        role: role as "CO_HOST" | "MODERATOR" | "GUEST_SPEAKER" | "TECHNICAL_SUPPORT",
        revenueSharePercentage,
        status: "PENDING",
        invitedById,
      },
    });
  } else {
    return prisma.classCollaborator.create({
      data: {
        consultantProfileId,
        classPlanId: planId,
        role: role as "CO_INSTRUCTOR" | "TEACHING_ASSISTANT" | "GUEST_LECTURER" | "CONTENT_CREATOR",
        revenueSharePercentage,
        status: "PENDING",
        invitedById,
      },
    });
  }
}

/**
 * Respond to a collaboration invitation (accept or decline).
 * When accepted, auto-creates a collaborator Stream chat channel.
 */
export async function respondToInvitation(
  planType: PlanType,
  collaborationId: string,
  consultantProfileId: string,
  response: "ACCEPTED" | "DECLINED",
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  if (planType === "webinar") {
    const collab = await prisma.webinarCollaborator.findUnique({
      where: { id: collaborationId },
    });
    if (!collab || collab.consultantProfileId !== consultantProfileId) return null;
    if (collab.status !== "PENDING") return null;

    const updated = await prisma.webinarCollaborator.update({
      where: { id: collaborationId },
      data: { status: response, respondedAt: new Date() },
    });

    if (response === "ACCEPTED") {
      try {
        const { createCollaboratorChannel } = await import(
          "@/actions/stream/chat/channel.action"
        );
        await createCollaboratorChannel("webinar", collab.webinarPlanId);
      } catch (err) {
        console.error("Failed to create collaborator channel:", err);
      }
    }

    return updated;
  } else {
    const collab = await prisma.classCollaborator.findUnique({
      where: { id: collaborationId },
    });
    if (!collab || collab.consultantProfileId !== consultantProfileId) return null;
    if (collab.status !== "PENDING") return null;

    const updated = await prisma.classCollaborator.update({
      where: { id: collaborationId },
      data: { status: response, respondedAt: new Date() },
    });

    if (response === "ACCEPTED") {
      try {
        const { createCollaboratorChannel } = await import(
          "@/actions/stream/chat/channel.action"
        );
        await createCollaboratorChannel("class", collab.classPlanId);
      } catch (err) {
        console.error("Failed to create collaborator channel:", err);
      }
    }

    return updated;
  }
}

/**
 * Remove a collaborator (soft-delete: set status to REMOVED).
 */
export async function removeCollaborator(
  planType: PlanType,
  collaborationId: string,
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  if (planType === "webinar") {
    return prisma.webinarCollaborator.update({
      where: { id: collaborationId },
      data: { status: "REMOVED" },
    });
  } else {
    return prisma.classCollaborator.update({
      where: { id: collaborationId },
      data: { status: "REMOVED" },
    });
  }
}

/**
 * Update a collaborator's revenue share or role.
 */
export async function updateCollaborator(
  planType: PlanType,
  collaborationId: string,
  updates: { revenueSharePercentage?: number; role?: string },
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  if (planType === "webinar") {
    const collab = await prisma.webinarCollaborator.findUnique({
      where: { id: collaborationId },
    });
    if (!collab) return null;

    if (updates.revenueSharePercentage !== undefined) {
      const valid = await validateRevenueShares(
        "webinar",
        collab.webinarPlanId,
        updates.revenueSharePercentage,
        collaborationId,
      );
      if (!valid) return null;
    }

    return prisma.webinarCollaborator.update({
      where: { id: collaborationId },
      data: {
        ...(updates.revenueSharePercentage !== undefined && {
          revenueSharePercentage: updates.revenueSharePercentage,
        }),
        ...(updates.role && {
          role: updates.role as "CO_HOST" | "MODERATOR" | "GUEST_SPEAKER" | "TECHNICAL_SUPPORT",
        }),
      },
    });
  } else {
    const collab = await prisma.classCollaborator.findUnique({
      where: { id: collaborationId },
    });
    if (!collab) return null;

    if (updates.revenueSharePercentage !== undefined) {
      const valid = await validateRevenueShares(
        "class",
        collab.classPlanId,
        updates.revenueSharePercentage,
        collaborationId,
      );
      if (!valid) return null;
    }

    return prisma.classCollaborator.update({
      where: { id: collaborationId },
      data: {
        ...(updates.revenueSharePercentage !== undefined && {
          revenueSharePercentage: updates.revenueSharePercentage,
        }),
        ...(updates.role && {
          role: updates.role as "CO_INSTRUCTOR" | "TEACHING_ASSISTANT" | "GUEST_LECTURER" | "CONTENT_CREATOR",
        }),
      },
    });
  }
}

/**
 * Get all collaborators for a plan.
 */
export async function getCollaborators(
  planType: PlanType,
  planId: string,
) {
  const activeStatuses: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

  if (planType === "webinar") {
    return prisma.webinarCollaborator.findMany({
      where: { webinarPlanId: planId, status: { in: activeStatuses } },
      include: {
        consultantProfile: {
          include: { user: { select: { name: true, image: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  } else {
    return prisma.classCollaborator.findMany({
      where: { classPlanId: planId, status: { in: activeStatuses } },
      include: {
        consultantProfile: {
          include: { user: { select: { name: true, image: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }
}

/**
 * Get all collaborations for a consultant.
 */
export async function getMyCollaborations(consultantProfileId: string) {
  const [webinarCollabs, classCollabs] = await Promise.all([
    prisma.webinarCollaborator.findMany({
      where: {
        consultantProfileId,
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      include: {
        webinarPlan: {
          select: { id: true, title: true, price: true },
        },
        invitedBy: {
          include: { user: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.classCollaborator.findMany({
      where: {
        consultantProfileId,
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      include: {
        classPlan: {
          select: { id: true, title: true, price: true },
        },
        invitedBy: {
          include: { user: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    webinarCollaborations: webinarCollabs,
    classCollaborations: classCollabs,
  };
}

/**
 * Validate that total revenue shares don't exceed 90% (host keeps min 10%).
 */
export async function validateRevenueShares(
  planType: PlanType,
  planId: string,
  newShare: number,
  excludeId?: string,
): Promise<boolean> {
  let currentTotal = 0;

  if (planType === "webinar") {
    const collabs = await prisma.webinarCollaborator.findMany({
      where: {
        webinarPlanId: planId,
        status: { in: ["PENDING", "ACCEPTED"] },
        ...(excludeId && { NOT: { id: excludeId } }),
      },
      select: { revenueSharePercentage: true },
    });
    currentTotal = collabs.reduce((sum, c) => sum + c.revenueSharePercentage, 0);
  } else {
    const collabs = await prisma.classCollaborator.findMany({
      where: {
        classPlanId: planId,
        status: { in: ["PENDING", "ACCEPTED"] },
        ...(excludeId && { NOT: { id: excludeId } }),
      },
      select: { revenueSharePercentage: true },
    });
    currentTotal = collabs.reduce((sum, c) => sum + c.revenueSharePercentage, 0);
  }

  return currentTotal + newShare <= 100 - MIN_HOST_SHARE;
}

/**
 * Calculate revenue split for a payment (owner gets remainder).
 */
export async function calculateRevenueSplit(
  planType: PlanType,
  planId: string,
  totalAmount: number,
): Promise<{ consultantProfileId: string; share: number; role: string }[]> {
  const collabs = await getCollaborators(planType, planId);
  const acceptedCollabs = collabs.filter((c) => c.status === "ACCEPTED");

  if (acceptedCollabs.length === 0) {
    return []; // No collaborators - regular single-owner flow
  }

  const splits: { consultantProfileId: string; share: number; role: string }[] =
    [];

  let collaboratorTotal = 0;
  for (const collab of acceptedCollabs) {
    const share = Math.round(
      (totalAmount * collab.revenueSharePercentage) / 100,
    );
    collaboratorTotal += share;
    splits.push({
      consultantProfileId: collab.consultantProfileId,
      share,
      role: collab.role,
    });
  }

  // Owner gets the remainder
  const ownerShare = totalAmount - collaboratorTotal;

  // Get plan's owner consultant profile
  let ownerConsultantProfileId: string | null = null;
  if (planType === "webinar") {
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  } else {
    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  }

  if (ownerConsultantProfileId) {
    splits.unshift({
      consultantProfileId: ownerConsultantProfileId,
      share: ownerShare,
      role: "OWNER",
    });
  }

  return splits;
}
