import prisma from "@/lib/prisma";
import {
  Prisma,
  type WebinarCollaboratorRole,
  type ClassCollaboratorRole,
} from "@prisma/client";
import type {
  WebinarCollaborator,
  ClassCollaborator,
  CollaboratorStatus,
} from "@prisma/client";
import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import { getStreamChatClient } from "@/lib/stream-client";
import {
  notifyCollaboratorInvited,
  notifyCollaboratorAccepted,
  notifyCollaboratorRemoved,
} from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";

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
  // Validate percentage range
  if (revenueSharePercentage <= 0 || revenueSharePercentage > 90) {
    return null;
  }

  // Verify the invited consultant profile exists before creating a collaborator record.
  // Without this check, a stale or fabricated consultantProfileId creates an orphaned row.
  const inviteeProfile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { id: true },
  });
  if (!inviteeProfile) {
    return null;
  }

  // FIX B1: Wrap validation + creation in a serializable transaction
  // to prevent concurrent invites from exceeding the 90% cap.
  const txResult = await prisma.$transaction(
    async (tx) => {
      // Validate revenue share total <= 90% INSIDE transaction
      const valid = await validateRevenueSharesTx(
        tx,
        planType,
        planId,
        revenueSharePercentage,
      );
      if (!valid) return null;

      // FIX #6: Check for ANY existing collaboration (including REMOVED/DECLINED).
      // If REMOVED/DECLINED, re-activate instead of creating to respect unique constraint.
      if (planType === "webinar") {
        const existing = await tx.webinarCollaborator.findFirst({
          where: { webinarPlanId: planId, consultantProfileId },
        });

        if (existing) {
          if (existing.status === "REMOVED" || existing.status === "DECLINED") {
            // Re-activate with new parameters
            return tx.webinarCollaborator.update({
              where: { id: existing.id },
              data: {
                role: role as WebinarCollaboratorRole,
                revenueSharePercentage,
                status: "PENDING",
                invitedById,
                respondedAt: null,
              },
            });
          }
          // PENDING or ACCEPTED — already active
          return null;
        }

        return tx.webinarCollaborator.create({
          data: {
            consultantProfileId,
            webinarPlanId: planId,
            role: role as WebinarCollaboratorRole,
            revenueSharePercentage,
            status: "PENDING",
            invitedById,
          },
        });
      } else {
        const existing = await tx.classCollaborator.findFirst({
          where: { classPlanId: planId, consultantProfileId },
        });

        if (existing) {
          if (existing.status === "REMOVED" || existing.status === "DECLINED") {
            // Re-activate with new parameters
            return tx.classCollaborator.update({
              where: { id: existing.id },
              data: {
                role: role as ClassCollaboratorRole,
                revenueSharePercentage,
                status: "PENDING",
                invitedById,
                respondedAt: null,
              },
            });
          }
          // PENDING or ACCEPTED — already active
          return null;
        }

        return tx.classCollaborator.create({
          data: {
            consultantProfileId,
            classPlanId: planId,
            role: role as ClassCollaboratorRole,
            revenueSharePercentage,
            status: "PENDING",
            invitedById,
          },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    },
  );

  // Fire-and-forget: notify invited collaborator
  if (txResult) {
    try {
      const invitedProfile = await prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { userId: true },
      });
      const planTitle =
        planType === "webinar"
          ? (
              await prisma.webinarPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title
          : (
              await prisma.classPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title;

      const inviterProfile = await prisma.consultantProfile.findUnique({
        where: { id: invitedById },
        select: { user: { select: { name: true } } },
      });

      if (invitedProfile) {
        await notifyCollaboratorInvited(invitedProfile.userId, {
          planTitle: planTitle ?? "Unknown Plan",
          planType,
          role,
          revenueSharePercentage,
          ownerName: inviterProfile?.user?.name ?? "Plan Owner",
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
      }
    } catch (error) {
      console.error(
        "[collaborators] Failed to send invitation notification:",
        error,
      );
    }
  }

  return txResult;
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
    if (!collab || collab.consultantProfileId !== consultantProfileId)
      return null;
    if (collab.status !== "PENDING") return null;

    const updated = await prisma.webinarCollaborator.update({
      where: { id: collaborationId },
      data: { status: response, respondedAt: new Date() },
    });

    if (response === "ACCEPTED") {
      try {
        const { createCollaboratorChannel } =
          await import("@/actions/stream/chat/channel.action");
        await createCollaboratorChannel("webinar", collab.webinarPlanId);
      } catch (err) {
        console.error("Failed to create collaborator channel:", err);
      }

      // Notify plan owner that collaborator accepted
      try {
        const plan = await prisma.webinarPlan.findUnique({
          where: { id: collab.webinarPlanId },
          select: {
            title: true,
            consultantProfile: { select: { userId: true } },
          },
        });
        const collabProfile = await prisma.consultantProfile.findUnique({
          where: { id: consultantProfileId },
          select: { user: { select: { name: true } } },
        });
        if (plan?.consultantProfile?.userId) {
          await notifyCollaboratorAccepted(plan.consultantProfile.userId, {
            planTitle: plan.title,
            planType: "webinar",
            collaboratorName: collabProfile?.user?.name ?? "Collaborator",
            role: updated.role,
            dashboardUrl: `${getAppUrl()}/dashboard`,
          });
        }
      } catch (error) {
        console.error(
          "[collaborators] Failed to send acceptance notification:",
          error,
        );
      }
    }

    return updated;
  } else {
    const collab = await prisma.classCollaborator.findUnique({
      where: { id: collaborationId },
    });
    if (!collab || collab.consultantProfileId !== consultantProfileId)
      return null;
    if (collab.status !== "PENDING") return null;

    const updated = await prisma.classCollaborator.update({
      where: { id: collaborationId },
      data: { status: response, respondedAt: new Date() },
    });

    if (response === "ACCEPTED") {
      try {
        const { createCollaboratorChannel } =
          await import("@/actions/stream/chat/channel.action");
        await createCollaboratorChannel("class", collab.classPlanId);
      } catch (err) {
        console.error("Failed to create collaborator channel:", err);
      }

      // Notify plan owner that collaborator accepted
      try {
        const plan = await prisma.classPlan.findUnique({
          where: { id: collab.classPlanId },
          select: {
            title: true,
            consultantProfile: { select: { userId: true } },
          },
        });
        const collabProfile = await prisma.consultantProfile.findUnique({
          where: { id: consultantProfileId },
          select: { user: { select: { name: true } } },
        });
        if (plan?.consultantProfile?.userId) {
          await notifyCollaboratorAccepted(plan.consultantProfile.userId, {
            planTitle: plan.title,
            planType: "class",
            collaboratorName: collabProfile?.user?.name ?? "Collaborator",
            role: updated.role,
            dashboardUrl: `${getAppUrl()}/dashboard`,
          });
        }
      } catch (error) {
        console.error(
          "[collaborators] Failed to send acceptance notification:",
          error,
        );
      }
    }

    return updated;
  }
}

/**
 * Remove a collaborator (soft-delete: set status to REMOVED).
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
 */
export async function removeCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  if (planType === "webinar") {
    const collab = await prisma.webinarCollaborator.findFirst({
      where: { id: collaborationId, webinarPlanId: planId },
    });
    if (!collab) return null;

    const result = await prisma.webinarCollaborator.update({
      where: { id: collaborationId },
      data: { status: "REMOVED" },
    });

    // Fire-and-forget: notify removed collaborator + revoke Stream channel access
    try {
      const [profile, plan, webinars] = await Promise.all([
        prisma.consultantProfile.findUnique({
          where: { id: collab.consultantProfileId },
          select: { userId: true },
        }),
        prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { title: true },
        }),
        prisma.webinar.findMany({
          where: { webinarPlanId: planId },
          select: { id: true },
        }),
      ]);
      if (profile?.userId) {
        await notifyCollaboratorRemoved(profile.userId, {
          planTitle: plan?.title ?? "Unknown Plan",
          planType: "webinar",
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
        // FIX #592: Remove collaborator from all webinar event channels + collab channel
        await Promise.all([
          ...webinars.map((webinar) =>
            removeUserFromEventChannel("webinar", webinar.id, profile.userId),
          ),
          // Also remove from the plan-level collaborator channel
          getStreamChatClient()
            .channel("messaging", `collab-webinar-${planId}`)
            .removeMembers([profile.userId])
            .catch(() => {}), // Ignore if channel doesn't exist
        ]);
      }
    } catch (error) {
      console.error(
        "[collaborators] Failed to send removal notification:",
        error,
      );
    }

    return result;
  } else {
    const collab = await prisma.classCollaborator.findFirst({
      where: { id: collaborationId, classPlanId: planId },
    });
    if (!collab) return null;

    const result = await prisma.classCollaborator.update({
      where: { id: collaborationId },
      data: { status: "REMOVED" },
    });

    // Fire-and-forget: notify removed collaborator + revoke Stream channel access
    try {
      const [profile, plan, classes] = await Promise.all([
        prisma.consultantProfile.findUnique({
          where: { id: collab.consultantProfileId },
          select: { userId: true },
        }),
        prisma.classPlan.findUnique({
          where: { id: planId },
          select: { title: true },
        }),
        prisma.class.findMany({
          where: { classPlanId: planId },
          select: { id: true },
        }),
      ]);
      if (profile?.userId) {
        await notifyCollaboratorRemoved(profile.userId, {
          planTitle: plan?.title ?? "Unknown Plan",
          planType: "class",
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
        // FIX #592: Remove collaborator from all class event channels + collab channel
        await Promise.all([
          ...classes.map((classEvent) =>
            removeUserFromEventChannel("class", classEvent.id, profile.userId),
          ),
          // Also remove from the plan-level collaborator channel
          getStreamChatClient()
            .channel("messaging", `collab-class-${planId}`)
            .removeMembers([profile.userId])
            .catch(() => {}), // Ignore if channel doesn't exist
        ]);
      }
    } catch (error) {
      console.error(
        "[collaborators] Failed to send removal notification:",
        error,
      );
    }

    return result;
  }
}

/**
 * Update a collaborator's revenue share or role.
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
 */
export async function updateCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
  updates: { revenueSharePercentage?: number; role?: string },
): Promise<WebinarCollaborator | ClassCollaborator | null> {
  // Validate percentage range if updating
  if (updates.revenueSharePercentage !== undefined) {
    if (
      updates.revenueSharePercentage <= 0 ||
      updates.revenueSharePercentage > 90
    ) {
      return null;
    }
  }

  return prisma.$transaction(
    async (tx) => {
      if (planType === "webinar") {
        // Verify collaborator belongs to this plan (IDOR prevention)
        const collab = await tx.webinarCollaborator.findFirst({
          where: { id: collaborationId, webinarPlanId: planId },
        });
        if (!collab) return null;

        if (updates.revenueSharePercentage !== undefined) {
          const valid = await validateRevenueSharesTx(
            tx,
            "webinar",
            collab.webinarPlanId,
            updates.revenueSharePercentage,
            collaborationId,
          );
          if (!valid) return null;
        }

        return tx.webinarCollaborator.update({
          where: { id: collaborationId },
          data: {
            ...(updates.revenueSharePercentage !== undefined && {
              revenueSharePercentage: updates.revenueSharePercentage,
            }),
            ...(updates.role && {
              role: updates.role as WebinarCollaboratorRole,
            }),
          },
        });
      } else {
        // Verify collaborator belongs to this plan (IDOR prevention)
        const collab = await tx.classCollaborator.findFirst({
          where: { id: collaborationId, classPlanId: planId },
        });
        if (!collab) return null;

        if (updates.revenueSharePercentage !== undefined) {
          const valid = await validateRevenueSharesTx(
            tx,
            "class",
            collab.classPlanId,
            updates.revenueSharePercentage,
            collaborationId,
          );
          if (!valid) return null;
        }

        return tx.classCollaborator.update({
          where: { id: collaborationId },
          data: {
            ...(updates.revenueSharePercentage !== undefined && {
              revenueSharePercentage: updates.revenueSharePercentage,
            }),
            ...(updates.role && {
              role: updates.role as ClassCollaboratorRole,
            }),
          },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    },
  );
}

/**
 * Get all collaborators for a plan.
 */
export async function getCollaborators(planType: PlanType, planId: string) {
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

type CollaboratorItem = Awaited<ReturnType<typeof getCollaborators>>[number];

export type CollaboratorAuthResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ok"; data: CollaboratorItem[] };

/**
 * Fetch collaborators for a plan and apply visibility scoping based on the
 * requesting user's role (owner / accepted collaborator / pending invitee).
 * Returns a discriminated union so HTTP concerns stay in the route layer.
 */
export async function getCollaboratorsForUser(
  planType: PlanType,
  planId: string,
  userId: string,
): Promise<CollaboratorAuthResult> {
  const planQuery =
    planType === "webinar"
      ? prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        })
      : prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        });

  const [plan, requesterProfile] = await Promise.all([
    planQuery,
    prisma.consultantProfile.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);

  if (!plan) return { status: "not_found" };

  const requesterProfileId = requesterProfile?.id;

  // Short-circuit: no consultant profile means cannot be owner or collaborator.
  // Avoids an unnecessary getCollaborators DB call for consultee / unauthenticated requests.
  if (!requesterProfileId) return { status: "forbidden" };

  const isOwner = plan.consultantProfileId === requesterProfileId;

  const collaborators = await getCollaborators(planType, planId);

  if (isOwner) {
    return { status: "ok", data: collaborators };
  }

  const ownRecord = collaborators.find(
    (c) => c.consultantProfileId === requesterProfileId,
  );

  if (ownRecord?.status === "ACCEPTED") {
    return {
      status: "ok",
      data: collaborators.filter((c) => c.status === "ACCEPTED"),
    };
  }

  if (ownRecord?.status === "PENDING") {
    return { status: "ok", data: [ownRecord] };
  }

  return { status: "forbidden" };
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
          select: {
            id: true,
            title: true,
            price: true,
            durationInHours: true,
            maxParticipants: true,
            language: true,
            level: true,
            consultantProfile: {
              select: { user: { select: { name: true, image: true } } },
            },
            collaborators: {
              where: { status: { in: ["PENDING", "ACCEPTED"] } },
              select: {
                id: true,
                role: true,
                revenueSharePercentage: true,
                status: true,
                consultantProfile: {
                  select: {
                    id: true,
                    user: { select: { name: true, image: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            webinars: {
              where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
              include: {
                appointment: {
                  include: {
                    slotsOfAppointment: {
                      select: {
                        startsAt: true,
                        endsAt: true,
                        isTentative: true,
                        _count: { select: { user: true } },
                      },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 5,
            },
          },
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
          select: {
            id: true,
            title: true,
            price: true,
            sessionDurationInHours: true,
            maxParticipants: true,
            meetingsPerWeek: true,
            durationInMonths: true,
            totalSessions: true,
            consultantProfile: {
              select: { user: { select: { name: true, image: true } } },
            },
            collaborators: {
              where: { status: { in: ["PENDING", "ACCEPTED"] } },
              select: {
                id: true,
                role: true,
                revenueSharePercentage: true,
                status: true,
                consultantProfile: {
                  select: {
                    id: true,
                    user: { select: { name: true, image: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            classes: {
              where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
              include: {
                appointments: {
                  include: {
                    slotsOfAppointment: {
                      select: {
                        startsAt: true,
                        endsAt: true,
                        isTentative: true,
                        _count: { select: { user: true } },
                      },
                      orderBy: { startsAt: "asc" },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 5,
            },
          },
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
 * Get all plans owned by this consultant that have collaborators.
 * Returns plans with their collaborator lists and schedule data (host perspective).
 */
export async function getHostedCollaborations(consultantProfileId: string) {
  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: {
        consultantProfileId,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        durationInHours: true,
        maxParticipants: true,
        language: true,
        level: true,
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        webinars: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointment: {
              include: {
                slotsOfAppointment: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    _count: { select: { user: true } },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.classPlan.findMany({
      where: {
        consultantProfileId,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        sessionDurationInHours: true,
        maxParticipants: true,
        meetingsPerWeek: true,
        durationInMonths: true,
        totalSessions: true,
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        classes: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointments: {
              include: {
                slotsOfAppointment: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    _count: { select: { user: true } },
                  },
                  orderBy: { startsAt: "asc" },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { webinarPlans, classPlans };
}

/**
 * Validate that total revenue shares don't exceed 90% (host keeps min 10%).
 * Transaction-safe version that accepts a Prisma transaction client.
 */
async function validateRevenueSharesTx(
  db: Prisma.TransactionClient | typeof prisma,
  planType: PlanType,
  planId: string,
  newShare: number,
  excludeId?: string,
): Promise<boolean> {
  let currentTotal = 0;

  if (planType === "webinar") {
    const collabs = await db.webinarCollaborator.findMany({
      where: {
        webinarPlanId: planId,
        status: { in: ["PENDING", "ACCEPTED"] },
        ...(excludeId && { NOT: { id: excludeId } }),
      },
      select: { revenueSharePercentage: true },
    });
    currentTotal = collabs.reduce(
      (sum, c) => sum + c.revenueSharePercentage,
      0,
    );
  } else {
    const collabs = await db.classCollaborator.findMany({
      where: {
        classPlanId: planId,
        status: { in: ["PENDING", "ACCEPTED"] },
        ...(excludeId && { NOT: { id: excludeId } }),
      },
      select: { revenueSharePercentage: true },
    });
    currentTotal = collabs.reduce(
      (sum, c) => sum + c.revenueSharePercentage,
      0,
    );
  }

  return currentTotal + newShare <= 100 - MIN_HOST_SHARE;
}

/**
 * Validate that total revenue shares don't exceed 90% (host keeps min 10%).
 * Public wrapper that uses the global prisma client.
 */
export async function validateRevenueShares(
  planType: PlanType,
  planId: string,
  newShare: number,
  excludeId?: string,
): Promise<boolean> {
  return validateRevenueSharesTx(prisma, planType, planId, newShare, excludeId);
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
