import prisma from "@/lib/prisma";

/**
 * Who may read `/api/scheduling/appointments` when the query does not name
 * the session's own profile id (FAMILIARISE_WEB-2V, #1703 B10).
 *
 * The route compared the `?consultantProfileId=` filter against the SESSION's
 * profile ids, and those lag the database: a consultant who onboarded after
 * signing in carried no `consultantProfileId` on the cookie-cached session,
 * so their own allocate page answered 403 on the event-slots read. The
 * consultee's reschedule picker names the CONSULTANT's id (the grid it is
 * drawing) and never matched at all. Two grants close both: the caller's
 * fresh profile ids, and — only when an event id bounds the read to one
 * booking — the delivering consultant or requesting consultee of that event.
 */

export interface EventSlotsFilter {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
}

export interface EventSlotsEventIds {
  consultationId: string | null;
  subscriptionId: string | null;
  webinarId: string | null;
  classId: string | null;
}

interface EventParties {
  consultantProfileId: string | null;
  requestedById: string | null;
}

async function eventParties(
  ids: EventSlotsEventIds,
): Promise<EventParties | null> {
  if (ids.consultationId) {
    const row = await prisma.consultation.findUnique({
      where: { id: ids.consultationId },
      select: {
        requestedById: true,
        consultationPlan: { select: { consultantProfileId: true } },
      },
    });
    return row
      ? {
          consultantProfileId:
            row.consultationPlan?.consultantProfileId ?? null,
          requestedById: row.requestedById,
        }
      : null;
  }
  if (ids.subscriptionId) {
    const row = await prisma.subscription.findUnique({
      where: { id: ids.subscriptionId },
      select: {
        requestedById: true,
        subscriptionPlan: { select: { consultantProfileId: true } },
      },
    });
    return row
      ? {
          consultantProfileId:
            row.subscriptionPlan?.consultantProfileId ?? null,
          requestedById: row.requestedById,
        }
      : null;
  }
  if (ids.webinarId) {
    const row = await prisma.webinar.findUnique({
      where: { id: ids.webinarId },
      select: { webinarPlan: { select: { consultantProfileId: true } } },
    });
    return row
      ? {
          consultantProfileId: row.webinarPlan?.consultantProfileId ?? null,
          requestedById: null,
        }
      : null;
  }
  if (ids.classId) {
    const row = await prisma.class.findUnique({
      where: { id: ids.classId },
      select: { classPlan: { select: { consultantProfileId: true } } },
    });
    return row
      ? {
          consultantProfileId: row.classPlan?.consultantProfileId ?? null,
          requestedById: null,
        }
      : null;
  }
  return null;
}

export async function canReadEventSlots(params: {
  userId: string;
  filter: EventSlotsFilter;
  eventIds: EventSlotsEventIds;
}): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { consultantProfileId: true, consulteeProfileId: true },
  });
  if (!user) return false;

  const { consultantProfileId, consulteeProfileId } = params.filter;
  // Grant 1: the filter names the caller's own (fresh) profile.
  if (consultantProfileId && consultantProfileId === user.consultantProfileId)
    return true;
  if (consulteeProfileId && consulteeProfileId === user.consulteeProfileId)
    return true;

  // Grant 2: a single named event, and the caller is one of its two parties.
  // The event id AND-narrows the read, so nothing beyond that booking leaks.
  const parties = await eventParties(params.eventIds);
  if (!parties) return false;
  const isDeliveringConsultant =
    !!user.consultantProfileId &&
    parties.consultantProfileId === user.consultantProfileId;
  const isRequestingConsultee =
    !!user.consulteeProfileId &&
    parties.requestedById === user.consulteeProfileId;
  return isDeliveringConsultant || isRequestingConsultee;
}
