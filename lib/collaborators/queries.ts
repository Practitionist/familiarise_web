import type { CollaboratorStatus } from "@prisma/client";
import { scopeToWhereOrgId, type Scope } from "@/lib/api/scope/parse";
import { liveParticipant } from "@/lib/booking/participants";
import { managedAsNamedExpertWhere } from "@/lib/enterprise/membership-guards";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  LIVE_CLASS_COLLABORATOR,
  LIVE_WEBINAR_COLLABORATOR,
} from "./live-plan";
import { planWhere, type PlanRef } from "./team";
import {
  COLLABORATOR_VIEW_SELECT,
  projectTeamForViewer,
  resolveCollaborationViewer,
  toManagerView,
  type CollaborationViewer,
  type CollaboratorView,
  type CollaboratorViewRow,
} from "./viewer";

/** A row that holds a place on a plan: invited or on the team. */
const LIVE_STATUSES: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

/** A plan's invited and accepted collaborators, oldest first. An erased profile is never listed. */
export function livePlanCollaborators(
  db: PrismaLike,
  ref: PlanRef,
): Promise<CollaboratorViewRow[]> {
  return db.collaborator.findMany({
    where: {
      ...planWhere(ref),
      status: { in: LIVE_STATUSES },
      consultantProfile: { deletedAt: null },
    },
    select: COLLABORATOR_VIEW_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export type PlanTeamResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | {
      status: "ok";
      data: CollaboratorView[];
      viewer: Exclude<CollaborationViewer, { kind: "none" }>;
    };

/** A plan's team as the signed-in user may see it. */
export async function getPlanTeamForUser(
  ref: PlanRef,
  userId: string,
  db: PrismaLike = prisma,
): Promise<PlanTeamResult> {
  const { plan, viewer } = await resolveCollaborationViewer(db, ref, userId);
  if (!plan) return { status: "not_found" };
  if (viewer.kind === "none") return { status: "forbidden" };
  const rows = await livePlanCollaborators(db, ref);
  return { status: "ok", data: projectTeamForViewer(rows, viewer), viewer };
}

type PeerRow = {
  status: CollaboratorStatus;
  revenueShareBps: number;
  consultantProfile: { id: string };
};

/** The accepted team and the viewer's own row; only the viewer's own share is shown. */
function peersFor<T extends PeerRow>(peers: T[], consultantProfileId: string) {
  return peers
    .filter(
      (peer) =>
        peer.status === "ACCEPTED" ||
        peer.consultantProfile.id === consultantProfileId,
    )
    .map((peer) => ({
      ...peer,
      revenueShareBps:
        peer.consultantProfile.id === consultantProfileId
          ? peer.revenueShareBps
          : null,
    }));
}

/** The row's own columns a collaborator's list never needs. */
const OWN_ROW_OMIT = {
  respondedAt: true,
  invitedById: true,
  endedByUserId: true,
} as const;

/** The collaborations an expert was invited to or is on, with each plan's schedule. */
export async function getMyCollaborations(consultantProfileId: string) {
  const [webinarCollabs, classCollabs, verifiedPayoutAccount] =
    await Promise.all([
      prisma.collaborator.findMany({
        where: {
          consultantProfileId,
          ...LIVE_WEBINAR_COLLABORATOR,
          status: { in: ["PENDING", "ACCEPTED"] },
        },
        omit: OWN_ROW_OMIT,
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
                select: {
                  id: true,
                  user: { select: { name: true, image: true } },
                },
              },
              collaborators: {
                where: { status: { in: ["PENDING", "ACCEPTED"] } },
                select: {
                  id: true,
                  role: true,
                  revenueShareBps: true,
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
                where: { status: { in: ["SCHEDULED"] } },
                include: {
                  appointment: {
                    include: {
                      _count: {
                        select: {
                          participants: {
                            where: { ...liveParticipant(), role: "CONSULTEE" },
                          },
                        },
                      },
                      occurrences: {
                        select: {
                          startsAt: true,
                          endsAt: true,
                          isTentative: true,
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
            select: { id: true, user: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.collaborator.findMany({
        where: {
          consultantProfileId,
          ...LIVE_CLASS_COLLABORATOR,
          status: { in: ["PENDING", "ACCEPTED"] },
        },
        omit: OWN_ROW_OMIT,
        include: {
          classPlan: {
            select: {
              id: true,
              title: true,
              price: true,
              sessionDurationInHours: true,
              maxParticipants: true,
              sessionsPerWeek: true,
              durationInMonths: true,
              totalSessions: true,
              lateJoinUntilSession: true,
              consultantProfile: {
                select: {
                  id: true,
                  user: { select: { name: true, image: true } },
                },
              },
              collaborators: {
                where: { status: { in: ["PENDING", "ACCEPTED"] } },
                select: {
                  id: true,
                  role: true,
                  revenueShareBps: true,
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
                where: { status: { in: ["SCHEDULED"] } },
                include: {
                  appointment: {
                    include: {
                      _count: {
                        select: {
                          participants: {
                            where: { ...liveParticipant(), role: "CONSULTEE" },
                          },
                        },
                      },
                      occurrences: {
                        select: {
                          startsAt: true,
                          endsAt: true,
                          isTentative: true,
                          ordinal: true,
                          completionStatus: true,
                          deletedAt: true,
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
            select: { id: true, user: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payoutAccount.findFirst({
        where: { consultantProfileId, isVerified: true },
        select: { id: true },
      }),
    ]);

  const payoutAccountReady = Boolean(verifiedPayoutAccount);

  return {
    webinarCollaborations: webinarCollabs.map((collab) => ({
      ...collab,
      payoutAccountReady,
      webinarPlan: collab.webinarPlan
        ? {
            ...collab.webinarPlan,
            collaborators: peersFor(
              collab.webinarPlan.collaborators,
              consultantProfileId,
            ),
          }
        : null,
    })),
    classCollaborations: classCollabs.map((collab) => ({
      ...collab,
      payoutAccountReady,
      classPlan: collab.classPlan
        ? {
            ...collab.classPlan,
            collaborators: peersFor(
              collab.classPlan.collaborators,
              consultantProfileId,
            ),
          }
        : null,
    })),
  };
}

/**
 * The plans an expert manages that carry collaborators, in one workspace
 * scope: an organisation's plan only while its active expert.
 */
export async function getHostedCollaborations(
  consultantProfileId: string,
  scope: Scope = { kind: "personal" },
) {
  return hostedCollaborationsWhere({
    ...managedAsNamedExpertWhere(consultantProfileId),
    ...scopeToWhereOrgId(scope),
  });
}

/** Every plan of an organisation that carries collaborators, whoever hosts it. */
export async function getOrgHostedCollaborations(organizationId: string) {
  return hostedCollaborationsWhere({ organizationId });
}

async function hostedCollaborationsWhere(
  planFilter:
    | (ReturnType<typeof managedAsNamedExpertWhere> & {
        organizationId?: string | null;
      })
    | { organizationId: string },
) {
  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: {
        ...planFilter,
        archivedAt: null,
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
        consultantProfile: {
          select: { user: { select: { name: true, image: true } } },
        },
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          select: COLLABORATOR_VIEW_SELECT,
          orderBy: { createdAt: "asc" },
        },
        webinars: {
          where: { status: { in: ["SCHEDULED"] } },
          include: {
            appointment: {
              include: {
                _count: {
                  select: {
                    participants: {
                      where: { ...liveParticipant(), role: "CONSULTEE" },
                    },
                  },
                },
                occurrences: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
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
        ...planFilter,
        archivedAt: null,
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
        sessionsPerWeek: true,
        durationInMonths: true,
        totalSessions: true,
        lateJoinUntilSession: true,
        consultantProfile: {
          select: { user: { select: { name: true, image: true } } },
        },
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          select: COLLABORATOR_VIEW_SELECT,
          orderBy: { createdAt: "asc" },
        },
        classes: {
          where: { status: { in: ["SCHEDULED"] } },
          include: {
            appointment: {
              include: {
                _count: {
                  select: {
                    participants: {
                      where: { ...liveParticipant(), role: "CONSULTEE" },
                    },
                  },
                },
                occurrences: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    ordinal: true,
                    completionStatus: true,
                    deletedAt: true,
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

  return {
    webinarPlans: webinarPlans.map((plan) => ({
      ...plan,
      collaborators: plan.collaborators.map(toManagerView),
    })),
    classPlans: classPlans.map((plan) => ({
      ...plan,
      collaborators: plan.collaborators.map(toManagerView),
    })),
  };
}
