import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { bookingOrgId } from "@/lib/stream-utils";
import {
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
    eventDirections.length > 0 && prisma.webinar?.findMany
      ? prisma.webinar.findMany({
          where: {
            status: { in: [...OPENABLE_EVENT_STATUSES] },
            OR: eventDirections.map((d) => ({
              webinarPlan: { consultantProfileId: d.consultantProfileId },
              appointment: {
                deletedAt: null,
                participants: { some: liveParticipant(d.participantUserId) },
              },
            })),
          },
          select: {
            webinarPlan: { select: { organizationId: true } },
            appointment: { select: { organizationId: true } },
          },
        })
      : Promise.resolve([]),
    eventDirections.length > 0 && prisma.class?.findMany
      ? prisma.class.findMany({
          where: {
            status: { in: [...OPENABLE_EVENT_STATUSES] },
            OR: eventDirections.map((d) => ({
              classPlan: { consultantProfileId: d.consultantProfileId },
              appointment: {
                deletedAt: null,
                participants: { some: liveParticipant(d.participantUserId) },
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
  if (!prisma.webinar?.findFirst) return false;
  const directions = buildEventDirections(a, b, userIdA, userIdB);
  if (directions.length === 0) return false;

  const found = await prisma.webinar.findFirst({
    where: {
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: directions.map((d) => ({
        webinarPlan: { consultantProfileId: d.consultantProfileId },
        appointment: {
          deletedAt: null,
          participants: { some: liveParticipant(d.participantUserId) },
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
  if (!prisma.class?.findFirst) return false;
  const directions = buildEventDirections(a, b, userIdA, userIdB);
  if (directions.length === 0) return false;

  const found = await prisma.class.findFirst({
    where: {
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: directions.map((d) => ({
        classPlan: { consultantProfileId: d.consultantProfileId },
        appointment: {
          deletedAt: null,
          participants: { some: liveParticipant(d.participantUserId) },
        },
      })),
    },
    select: { id: true },
  });

  return found !== null;
}
