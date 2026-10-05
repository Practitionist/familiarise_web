import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import {
  dmEligibleStatusFilter,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";

export type StreamEventType =
  | "webinar"
  | "class"
  | "consultation"
  | "subscription";

/**
 * Verify that `userId` is an active participant, host, or accepted collaborator
 * for the given event before creating or opening an event-linked Stream channel.
 */
export async function verifyEventAccess(
  userId: string,
  eventType: StreamEventType,
  eventId: string,
): Promise<boolean> {
  switch (eventType) {
    case "webinar": {
      const webinar = await prisma.webinar.findFirst({
        where: {
          id: eventId,
          status: { in: [...OPENABLE_EVENT_STATUSES] },
          OR: [
            { webinarPlan: { consultantProfile: { userId } } },
            {
              webinarPlan: {
                collaborators: {
                  some: {
                    status: "ACCEPTED",
                    consultantProfile: { userId, deletedAt: null },
                  },
                },
              },
            },
            {
              appointment: {
                deletedAt: null,
                participants: { some: liveParticipant(userId) },
              },
            },
          ],
        },
        select: { id: true },
      });
      return !!webinar;
    }
    case "class": {
      const classRow = await prisma.class.findFirst({
        where: {
          id: eventId,
          status: { in: [...OPENABLE_EVENT_STATUSES] },
          OR: [
            { classPlan: { consultantProfile: { userId } } },
            {
              classPlan: {
                collaborators: {
                  some: {
                    status: "ACCEPTED",
                    consultantProfile: { userId, deletedAt: null },
                  },
                },
              },
            },
            {
              appointment: {
                deletedAt: null,
                participants: { some: liveParticipant(userId) },
              },
            },
          ],
        },
        select: { id: true },
      });
      return !!classRow;
    }
    case "consultation": {
      const consultation = await prisma.consultation.findFirst({
        where: {
          id: eventId,
          status: dmEligibleStatusFilter(),
          OR: [
            { consultationPlan: { consultantProfile: { userId } } },
            { requestedBy: { userId } },
          ],
        },
        select: { id: true },
      });
      return !!consultation;
    }
    case "subscription": {
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: eventId,
          status: dmEligibleStatusFilter(),
          OR: [
            { subscriptionPlan: { consultantProfile: { userId } } },
            { requestedBy: { userId } },
          ],
        },
        select: { id: true },
      });
      return !!subscription;
    }
    default:
      return false;
  }
}
