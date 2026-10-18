// Resolves who an allocation is for: the owning consultant, the single
// consultee, and the event-type enum and relation names.

import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { EventType } from "@/utils/scheduling-engine/types";

/**
 * Lightweight pre-fetch to get consultantProfileId for lock acquisition.
 * Runs OUTSIDE the transaction, before the distributed lock is acquired.
 *
 * FIX Issue #1 from Architecture Review (#446):
 * autoAllocate() needs a consultant-level lock to prevent concurrent
 * auto-allocations from double-booking the same slots.
 */
export async function getConsultantProfileId(
  eventType: EventType,
  eventId: string,
): Promise<string | null> {
  switch (eventType) {
    case "consultation": {
      const event = await prisma.consultation.findUnique({
        where: { id: eventId },
        select: {
          consultationPlan: { select: { consultantProfileId: true } },
        },
      });
      return event?.consultationPlan?.consultantProfileId ?? null;
    }
    case "subscription": {
      const event = await prisma.subscription.findUnique({
        where: { id: eventId },
        select: {
          subscriptionPlan: { select: { consultantProfileId: true } },
        },
      });
      return event?.subscriptionPlan?.consultantProfileId ?? null;
    }
    case "webinar": {
      const event = await prisma.webinar.findUnique({
        where: { id: eventId },
        select: {
          webinarPlan: { select: { consultantProfileId: true } },
        },
      });
      return event?.webinarPlan?.consultantProfileId ?? null;
    }
    case "class": {
      const event = await prisma.class.findUnique({
        where: { id: eventId },
        select: { classPlan: { select: { consultantProfileId: true } } },
      });
      return event?.classPlan?.consultantProfileId ?? null;
    }
    default:
      return null;
  }
}

/**
 * #898 follow-up — resolve the single consultee's user id for the
 * consultee-booking lock key. Only CONSULTATION/SUBSCRIPTION have one booker;
 * WEBINAR/CLASS are group events (many attendees) with no single consultee to
 * serialize on, so they return null and skip the lock.
 */
export async function getConsulteeUserId(
  eventType: EventType,
  eventId: string,
): Promise<string | null> {
  switch (eventType) {
    case "consultation": {
      const event = await prisma.consultation.findUnique({
        where: { id: eventId },
        select: {
          requestedBy: { select: { user: { select: { id: true } } } },
        },
      });
      return event?.requestedBy?.user?.id ?? null;
    }
    case "subscription": {
      const event = await prisma.subscription.findUnique({
        where: { id: eventId },
        select: {
          requestedBy: { select: { user: { select: { id: true } } } },
        },
      });
      return event?.requestedBy?.user?.id ?? null;
    }
    default:
      return null;
  }
}

/**
 * Get Prisma appointment type enum
 */
export function getAppointmentType(eventType: EventType): AppointmentsType {
  const map: Record<EventType, AppointmentsType> = {
    consultation: AppointmentsType.CONSULTATION,
    subscription: AppointmentsType.SUBSCRIPTION,
    webinar: AppointmentsType.WEBINAR,
    class: AppointmentsType.CLASS,
  };
  return map[eventType];
}

/**
 * Get event relation field name for Prisma
 */
export function getEventRelationField(eventType: EventType): string {
  return eventType;
}
