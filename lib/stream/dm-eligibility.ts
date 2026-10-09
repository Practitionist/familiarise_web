import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { bookingOrgId } from "@/lib/stream-utils";
import {
  DM_ELIGIBLE_STATUSES,
  dmEligibleStatusFilter,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";

interface ProfilePair {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
}

interface Direction {
  consultantProfileId: string;
  requestedById: string;
}

interface EventDirection {
  consultantProfileId: string;
  participantUserId: string;
}

export class DmNotPermittedError extends Error {
  readonly userIdA: string;
  readonly userIdB: string;

  constructor(userIdA: string, userIdB: string) {
    super(
      `Direct message not permitted: users ${userIdA} and ${userIdB} share no eligible booking`,
    );
    this.name = "DmNotPermittedError";
    this.userIdA = userIdA;
    this.userIdB = userIdB;
  }
}

function eventHostOrPresenterPlanFilter(consultantProfileId: string) {
  return {
    OR: [
      { consultantProfileId },
      {
        collaborators: {
          some: {
            consultantProfileId,
            status: "ACCEPTED" as const,
            tier: "PRESENTER" as const,
            consultantProfile: { deletedAt: null },
          },
        },
      },
    ],
  };
}

export async function canDirectMessage(
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;

  const [a, b] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userIdA },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
    prisma.user.findUnique({
      where: { id: userIdB },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
  ]);

  if (!a || !b) return false;

  const [hasConsultation, hasSubscription, hasWebinar, hasClass] =
    await Promise.all([
      hasConsultationLink(a, b),
      hasSubscriptionLink(a, b),
      hasWebinarLink(a, b, userIdA, userIdB),
      hasClassLink(a, b, userIdA, userIdB),
    ]);

  return hasConsultation || hasSubscription || hasWebinar || hasClass;
}

export async function assertCanDirectMessage(
  userIdA: string,
  userIdB: string,
): Promise<void> {
  if (!(await canDirectMessage(userIdA, userIdB))) {
    throw new DmNotPermittedError(userIdA, userIdB);
  }
}

export interface PairBookingContexts {
  personalAllowed: boolean;
  organizations: string[];
}

export async function pairBookingContexts(
  userIdA: string,
  userIdB: string,
): Promise<PairBookingContexts> {
  const empty: PairBookingContexts = {
    personalAllowed: false,
    organizations: [],
  };
  if (!userIdA || !userIdB || userIdA === userIdB) return empty;

  const [a, b] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userIdA },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
    prisma.user.findUnique({
      where: { id: userIdB },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
  ]);
  if (!a || !b) return empty;

  const directions = buildDirections(a, b);
  const eventDirections = buildEventDirections(a, b, userIdA, userIdB);
  if (directions.length === 0 && eventDirections.length === 0) return empty;

  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    directions.length > 0
      ? prisma.consultation.findMany({
          where: {
            status: dmEligibleStatusFilter(),
            OR: directions.map((d) => ({
              consultationPlan: { consultantProfileId: d.consultantProfileId },
              requestedById: d.requestedById,
            })),
          },
          select: {
            consultationPlan: { select: { organizationId: true } },
            appointment: { select: { organizationId: true } },
          },
        })
      : Promise.resolve([]),
    directions.length > 0
      ? prisma.subscription.findMany({
          where: {
            status: dmEligibleStatusFilter(),
            OR: directions.map((d) => ({
              subscriptionPlan: { consultantProfileId: d.consultantProfileId },
              requestedById: d.requestedById,
            })),
          },
          select: {
            subscriptionPlan: { select: { organizationId: true } },
            appointment: { select: { organizationId: true } },
          },
        })
      : Promise.resolve([]),
    eventDirections.length > 0
      ? prisma.webinar.findMany({
          where: {
            status: { in: [...OPENABLE_EVENT_STATUSES] },
            OR: eventDirections.map((d) => ({
              webinarPlan: eventHostOrPresenterPlanFilter(
                d.consultantProfileId,
              ),
              appointment: {
                deletedAt: null,
                participants: {
                  some: {
                    ...liveParticipant(d.participantUserId),
                    role: "CONSULTEE",
                  },
                },
              },
            })),
          },
          select: {
            webinarPlan: { select: { organizationId: true } },
            appointment: { select: { organizationId: true } },
          },
        })
      : Promise.resolve([]),
    eventDirections.length > 0
      ? prisma.class.findMany({
          where: {
            status: { in: [...OPENABLE_EVENT_STATUSES] },
            OR: eventDirections.map((d) => ({
              classPlan: eventHostOrPresenterPlanFilter(d.consultantProfileId),
              appointment: {
                deletedAt: null,
                participants: {
                  some: {
                    ...liveParticipant(d.participantUserId),
                    role: "CONSULTEE",
                  },
                },
              },
            })),
          },
          select: {
            classPlan: { select: { organizationId: true } },
            appointment: { select: { organizationId: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  let personalAllowed = false;
  const organizations = new Set<string>();
  const recordOrg = (orgId: string | null) => {
    if (orgId) organizations.add(orgId);
    else personalAllowed = true;
  };

  for (const row of [...(consultations ?? []), ...(subscriptions ?? [])]) {
    recordOrg(bookingOrgId(row));
  }
  for (const w of webinars ?? []) {
    recordOrg(
      bookingOrgId({
        webinarPlan: w.webinarPlan,
        appointment: w.appointment,
      }),
    );
  }
  for (const c of classes ?? []) {
    recordOrg(
      bookingOrgId({
        classPlan: c.classPlan,
        appointment: c.appointment,
      }),
    );
  }

  return { personalAllowed, organizations: Array.from(organizations) };
}

export type ContextAppointmentCollaboratorRow = {
  status?: string;
  tier?: string;
  consultantProfile?: { userId?: string | null } | null;
};

export type ContextAppointmentRow = {
  id: string;
  appointmentType: string;
  occurrences?: { startsAt: Date; endsAt: Date }[];
  participants?: { userId: string; role?: string }[];
  consultation?: {
    status: string;
    requestedBy?: { userId: string } | null;
    consultationPlan?: {
      title: string;
      consultantProfile?: { userId: string } | null;
    } | null;
  } | null;
  subscription?: {
    status: string;
    requestedBy?: { userId: string } | null;
    subscriptionPlan?: {
      title: string;
      consultantProfile?: { userId: string } | null;
    } | null;
  } | null;
  webinar?: {
    status: string;
    webinarPlan?: {
      title: string;
      consultantProfile?: { userId: string } | null;
      collaborators?: ContextAppointmentCollaboratorRow[] | null;
    } | null;
  } | null;
  class?: {
    status: string;
    classPlan?: {
      title: string;
      consultantProfile?: { userId: string } | null;
      collaborators?: ContextAppointmentCollaboratorRow[] | null;
    } | null;
  } | null;
};

const ELIGIBLE_STATUS_SET = new Set<string>(DM_ELIGIBLE_STATUSES);
const EVENT_ELIGIBLE_STATUS_SET = new Set<string>([
  ...DM_ELIGIBLE_STATUSES,
  "IN_PROGRESS",
]);

function isMatchingUserPair(
  userId: string,
  counterpartyUserId: string,
  a?: string | null,
  b?: string | null,
): boolean {
  if (!a || !b) return false;
  return (
    (a === userId && b === counterpartyUserId) ||
    (a === counterpartyUserId && b === userId)
  );
}

function resolveEventPresenterIds(
  hostId: string | undefined,
  collaborators?: ContextAppointmentCollaboratorRow[] | null,
): Set<string> {
  const ids = new Set<string>();
  if (hostId) ids.add(hostId);
  for (const collab of collaborators ?? []) {
    const uid = collab.consultantProfile?.userId;
    if (!uid) continue;
    if (collab.status && collab.status !== "ACCEPTED") continue;
    if (collab.tier && collab.tier !== "PRESENTER") continue;
    ids.add(uid);
  }
  return ids;
}

function isMatchingPresenterAndLearner(
  userId: string,
  counterpartyUserId: string,
  presenterIds: Set<string>,
  learnerIds: Set<string>,
): boolean {
  return (
    (presenterIds.has(userId) && learnerIds.has(counterpartyUserId)) ||
    (presenterIds.has(counterpartyUserId) && learnerIds.has(userId))
  );
}

export function resolveVerifiedBookingContextTitle(
  appt: ContextAppointmentRow,
  userId: string,
  counterpartyUserId: string,
): string | null {
  if (appt.consultation) {
    if (!ELIGIBLE_STATUS_SET.has(appt.consultation.status)) return null;
    if (
      !isMatchingUserPair(
        userId,
        counterpartyUserId,
        appt.consultation.consultationPlan?.consultantProfile?.userId,
        appt.consultation.requestedBy?.userId,
      )
    ) {
      return null;
    }
    return appt.consultation.consultationPlan?.title ?? "Consultation";
  }
  if (appt.subscription) {
    if (!ELIGIBLE_STATUS_SET.has(appt.subscription.status)) return null;
    if (
      !isMatchingUserPair(
        userId,
        counterpartyUserId,
        appt.subscription.subscriptionPlan?.consultantProfile?.userId,
        appt.subscription.requestedBy?.userId,
      )
    ) {
      return null;
    }
    return appt.subscription.subscriptionPlan?.title ?? "Subscription";
  }

  const learnerIds = new Set(
    (appt.participants ?? [])
      .filter((p) => !p.role || p.role === "CONSULTEE")
      .map((p) => p.userId),
  );

  if (appt.webinar) {
    if (!EVENT_ELIGIBLE_STATUS_SET.has(appt.webinar.status)) return null;
    const presenterIds = resolveEventPresenterIds(
      appt.webinar.webinarPlan?.consultantProfile?.userId,
      appt.webinar.webinarPlan?.collaborators,
    );
    if (
      !isMatchingPresenterAndLearner(
        userId,
        counterpartyUserId,
        presenterIds,
        learnerIds,
      )
    ) {
      return null;
    }
    return appt.webinar.webinarPlan?.title ?? "Webinar";
  }

  if (appt.class) {
    if (!EVENT_ELIGIBLE_STATUS_SET.has(appt.class.status)) return null;
    const presenterIds = resolveEventPresenterIds(
      appt.class.classPlan?.consultantProfile?.userId,
      appt.class.classPlan?.collaborators,
    );
    if (
      !isMatchingPresenterAndLearner(
        userId,
        counterpartyUserId,
        presenterIds,
        learnerIds,
      )
    ) {
      return null;
    }
    return appt.class.classPlan?.title ?? "Class";
  }

  return null;
}

function buildDirections(a: ProfilePair, b: ProfilePair): Direction[] {
  const directions: Direction[] = [];
  if (a.consultantProfileId && b.consulteeProfileId) {
    directions.push({
      consultantProfileId: a.consultantProfileId,
      requestedById: b.consulteeProfileId,
    });
  }
  if (b.consultantProfileId && a.consulteeProfileId) {
    directions.push({
      consultantProfileId: b.consultantProfileId,
      requestedById: a.consulteeProfileId,
    });
  }
  return directions;
}

function buildEventDirections(
  a: ProfilePair,
  b: ProfilePair,
  userIdA: string,
  userIdB: string,
): EventDirection[] {
  const directions: EventDirection[] = [];
  if (a.consultantProfileId) {
    directions.push({
      consultantProfileId: a.consultantProfileId,
      participantUserId: userIdB,
    });
  }
  if (b.consultantProfileId) {
    directions.push({
      consultantProfileId: b.consultantProfileId,
      participantUserId: userIdA,
    });
  }
  return directions;
}

async function hasConsultationLink(
  a: ProfilePair,
  b: ProfilePair,
): Promise<boolean> {
  const directions = buildDirections(a, b);
  if (directions.length === 0) return false;

  const found = await prisma.consultation.findFirst({
    where: {
      status: dmEligibleStatusFilter(),
      OR: directions.map((d) => ({
        consultationPlan: { consultantProfileId: d.consultantProfileId },
        requestedById: d.requestedById,
      })),
    },
    select: { id: true },
  });

  return found !== null;
}

async function hasSubscriptionLink(
  a: ProfilePair,
  b: ProfilePair,
): Promise<boolean> {
  const directions = buildDirections(a, b);
  if (directions.length === 0) return false;

  const found = await prisma.subscription.findFirst({
    where: {
      status: dmEligibleStatusFilter(),
      OR: directions.map((d) => ({
        subscriptionPlan: { consultantProfileId: d.consultantProfileId },
        requestedById: d.requestedById,
      })),
    },
    select: { id: true },
  });

  return found !== null;
}

async function hasWebinarLink(
  a: ProfilePair,
  b: ProfilePair,
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  const directions = buildEventDirections(a, b, userIdA, userIdB);
  if (directions.length === 0) return false;

  const found = await prisma.webinar.findFirst({
    where: {
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: directions.map((d) => ({
        webinarPlan: eventHostOrPresenterPlanFilter(d.consultantProfileId),
        appointment: {
          deletedAt: null,
          participants: {
            some: {
              ...liveParticipant(d.participantUserId),
              role: "CONSULTEE",
            },
          },
        },
      })),
    },
    select: { id: true },
  });

  return found !== null;
}

async function hasClassLink(
  a: ProfilePair,
  b: ProfilePair,
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  const directions = buildEventDirections(a, b, userIdA, userIdB);
  if (directions.length === 0) return false;

  const found = await prisma.class.findFirst({
    where: {
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: directions.map((d) => ({
        classPlan: eventHostOrPresenterPlanFilter(d.consultantProfileId),
        appointment: {
          deletedAt: null,
          participants: {
            some: {
              ...liveParticipant(d.participantUserId),
              role: "CONSULTEE",
            },
          },
        },
      })),
    },
    select: { id: true },
  });

  return found !== null;
}
