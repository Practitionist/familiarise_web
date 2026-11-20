// Stages the booked and partially-scheduled notices inside the allocation
// transaction; the caller attempts them after commit.

import { liveLearnerSeat } from "@/lib/booking/participants";
import { collaboratorUserIds } from "@/lib/collaborators/recipients";
import type { Tx } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { EventType } from "@/utils/scheduling-engine/types";
import type { ApprovalOutcome } from "@/lib/booking/approve-request";
import {
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
  type StagedTrigger,
  type TriggerResult,
} from "@/lib/novu";
import { bookingNoticeScopes, notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";

/**
 * Stages the booked notice for both parties once real times exist. On a
 * webinar or class the learners are read from learner seats and the team from
 * the plan, never from staff participant rows. The expert and team are scoped
 * by the plan's host organisation, each learner by their own sponsor.
 */
export async function stageAllocationNotices(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  /**
   * #1206 — when only some of the plan's sessions were placed, the consultee
   * must be told how many are scheduled and what happens to the rest.
   */
  partial?: {
    partial: boolean;
    placedSessions?: number;
    requiredSessions?: number;
    unplacedSessions?: number;
  },
  outcome?: ApprovalOutcome,
  /** The rows this run wrote; each write is its own notice, never deduplicated into an earlier one. */
  placedIds: readonly (string | undefined)[] = [],
  /** This run confirms a reschedule: its "moved" notice is the one both parties get. */
  confirmsReschedule = false,
): Promise<StagedTrigger[]> {
  // #1775 B-9 — nothing is booked before payment: an awaiting-payment
  // approval's only consultee message is the pay-link email the mint sends.
  if (outcome === "awaiting_payment") return [];
  if (confirmsReschedule) return [];
  const prisma = tx;
  // A top-up or reallocation keeps past and cancelled rows; the notice names the next live one.
  const nextLiveSession = {
    ...LIVE_SLOT_WHERE,
    isTentative: false,
    startsAt: { gte: new Date() },
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
  let context: {
    /** The plan's expert, then its team. */
    hostUserIds: string[];
    hostOrganizationId: string | null;
    // #1206 — the partial notice goes to these only; the consultant was
    // already shown the shortfall and confirmed it.
    buyers: { userId: string; organizationId: string | null }[];
    consultantName: string;
    consulteeName: string;
    planTitle: string;
    firstStart: Date | null;
    appointmentId?: string;
  } | null = null;

  if (eventType === "consultation") {
    const row = await prisma.consultation.findUnique({
      where: { id: eventId },
      select: {
        consultationPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: {
              select: { user: { select: { id: true, name: true } } },
            },
          },
        },
        requestedBy: {
          select: { user: { select: { id: true, name: true } } },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
            // A rebooked consultation keeps its voided original; the notice names the live one.
            occurrences: {
              where: nextLiveSession,
              orderBy: { startsAt: "asc" },
              take: 1,
              select: { startsAt: true },
            },
          },
        },
      },
    });
    if (!row?.appointment) return [];
    context = {
      hostUserIds: [row.consultationPlan.consultantProfile.user.id],
      hostOrganizationId: row.consultationPlan.organizationId,
      buyers: [
        {
          userId: row.requestedBy.user.id,
          organizationId: row.appointment.organizationId,
        },
      ],
      consultantName:
        row.consultationPlan.consultantProfile.user.name || "Consultant",
      consulteeName: row.requestedBy.user.name || "Consultee",
      planTitle: row.consultationPlan.title,
      firstStart: row.appointment.occurrences[0]?.startsAt ?? null,
      appointmentId: row.appointment.id,
    };
  } else if (eventType === "subscription") {
    const row = await prisma.subscription.findUnique({
      where: { id: eventId },
      select: {
        subscriptionPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: {
              select: { user: { select: { id: true, name: true } } },
            },
          },
        },
        requestedBy: {
          select: { user: { select: { id: true, name: true } } },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
            occurrences: {
              where: nextLiveSession,
              orderBy: { startsAt: "asc" },
              take: 1,
              select: { startsAt: true },
            },
          },
        },
      },
    });
    if (!row?.appointment) return [];
    context = {
      hostUserIds: [row.subscriptionPlan.consultantProfile.user.id],
      hostOrganizationId: row.subscriptionPlan.organizationId,
      buyers: [
        {
          userId: row.requestedBy.user.id,
          organizationId: row.appointment.organizationId,
        },
      ],
      consultantName:
        row.subscriptionPlan.consultantProfile.user.name || "Consultant",
      consulteeName: row.requestedBy.user.name || "Consultee",
      planTitle: row.subscriptionPlan.title,
      firstStart: row.appointment.occurrences[0]?.startsAt ?? null,
      appointmentId: row.appointment.id,
    };
  } else if (eventType === "webinar") {
    const row = await prisma.webinar.findUnique({
      where: { id: eventId },
      select: {
        webinarPlan: {
          select: {
            id: true,
            title: true,
            organizationId: true,
            consultantProfile: {
              select: { user: { select: { id: true, name: true } } },
            },
          },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
            participants: {
              where: liveLearnerSeat(),
              select: {
                organizationId: true,
                user: { select: { id: true, name: true } },
              },
            },
            occurrences: {
              where: nextLiveSession,
              select: {
                startsAt: true,
              },
            },
          },
        },
      },
    });
    if (!row?.appointment) return [];
    const plan = row.webinarPlan;
    const hostUser = plan.consultantProfile?.user;
    if (!hostUser) return [];
    const userMap = new Map<string, string>();
    let firstStart: Date | null = null;
    for (const slot of row.appointment.occurrences) {
      if (!firstStart || slot.startsAt < firstStart) firstStart = slot.startsAt;
    }
    for (const { user: u } of row.appointment.participants)
      userMap.set(u.id, u.name ?? "Attendee");
    userMap.delete(hostUser.id);
    context = {
      hostUserIds: [
        hostUser.id,
        ...(await collaboratorUserIds("webinar", plan.id, tx)),
      ],
      hostOrganizationId: plan.organizationId,
      buyers: seatBuyers(row.appointment.participants),
      consultantName: hostUser.name || "Consultant",
      consulteeName:
        userMap.size === 1
          ? [...userMap.values()][0]
          : `${userMap.size} attendees`,
      planTitle: plan.title,
      firstStart,
      appointmentId: row.appointment.id,
    };
  } else {
    const row = await prisma.class.findUnique({
      where: { id: eventId },
      select: {
        classPlan: {
          select: {
            id: true,
            title: true,
            organizationId: true,
            consultantProfile: {
              select: { user: { select: { id: true, name: true } } },
            },
          },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
            participants: {
              where: liveLearnerSeat(),
              select: {
                organizationId: true,
                user: { select: { id: true, name: true } },
              },
            },
            occurrences: {
              where: nextLiveSession,
              select: {
                startsAt: true,
              },
            },
          },
        },
      },
    });
    if (!row?.appointment) return [];
    const appts = [row.appointment];
    const plan = row.classPlan;
    const hostUser = plan.consultantProfile?.user;
    if (!hostUser) return [];
    const host = hostUser;
    const userMap = new Map<string, string>();
    let firstStart: Date | null = null;
    for (const a of appts) {
      for (const slot of a.occurrences) {
        if (!firstStart || slot.startsAt < firstStart)
          firstStart = slot.startsAt;
      }
      for (const { user: u } of a.participants)
        userMap.set(u.id, u.name ?? "Attendee");
    }
    userMap.delete(host.id);
    context = {
      hostUserIds: [
        host.id,
        ...(await collaboratorUserIds("class", plan.id, tx)),
      ],
      hostOrganizationId: plan.organizationId,
      buyers: seatBuyers(appts.flatMap((a) => a.participants)),
      consultantName: host.name || "Consultant",
      consulteeName:
        userMap.size === 1
          ? [...userMap.values()][0]
          : `${userMap.size} attendees`,
      planTitle: plan.title,
      firstStart,
      appointmentId: appts[0]!.id,
    };
  }

  if (!context) return [];
  const booking = context;
  const groups = bookingNoticeScopes(booking);
  if (groups.length === 0) return [];

  const scoped = (organizationId: string | null) => ({
    ...notificationScope(organizationId),
    appointmentId: booking.appointmentId,
    dateTime: booking.firstStart?.toISOString(),
    appointmentType: eventType,
    consultantName: booking.consultantName,
    consulteeName: booking.consulteeName,
    planTitle: booking.planTitle,
    dashboardUrl: notificationHref(organizationId, "appointments"),
  });

  const placedKeys = placedIds
    .filter((id): id is string => typeof id === "string")
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const dedupeKey =
    placedKeys.length > 0
      ? `allocation:${booking.appointmentId ?? eventId}:${placedKeys.join(",")}`
      : undefined;
  const results: TriggerResult[] = [];
  for (const group of groups) {
    results.push(
      ...(await notifyAppointmentBooked(
        group.userIds,
        scoped(group.organizationId),
        { tx, dedupeKey },
      )),
    );
  }

  await stageSessionsScheduledEmail(tx, eventType, booking, placedKeys);

  // A separate notice, not a flag on the booked one: the placed times read as a
  // real booking, and the learner is told what happens to the rest.
  if (partial?.partial) {
    const hostIds = new Set(booking.hostUserIds);
    for (const group of groups) {
      const learners = group.userIds.filter((id) => !hostIds.has(id));
      if (learners.length === 0) continue;
      results.push(
        ...(await notifyAppointmentPartiallyScheduled(
          learners,
          {
            ...scoped(group.organizationId),
            placedSessions: partial.placedSessions ?? 0,
            requiredSessions: partial.requiredSessions ?? 0,
            unplacedSessions: partial.unplacedSessions ?? 0,
          },
          { tx, dedupeKey },
        )),
      );
    }
  }
  return results.flatMap((r) => (r.staged ? [r.staged] : []));
}

/**
 * The learner's one email when a 1:1 booking's times are placed after payment:
 * on the booking's first placement, unless its booked email already went.
 * Later batches ring the bell only. Staged here; the email relay sends it.
 */
async function stageSessionsScheduledEmail(
  tx: Tx,
  eventType: EventType,
  booking: {
    appointmentId?: string;
    buyers: { userId: string; organizationId: string | null }[];
    hostOrganizationId: string | null;
    consultantName: string;
    consulteeName: string;
    planTitle: string;
  },
  placedIds: string[],
): Promise<void> {
  if (eventType !== "consultation" && eventType !== "subscription") return;
  const { appointmentId } = booking;
  const learner = booking.buyers[0];
  if (!appointmentId || !learner || placedIds.length === 0) return;
  const earlierRows = await tx.appointmentOccurrence.count({
    where: { appointmentId, id: { notIn: placedIds } },
  });
  if (earlierRows > 0) return;
  const bookedEmail = await tx.failedEmail.findFirst({
    where: {
      entityRef: `appointment:${appointmentId}`,
      emailType: "APPOINTMENT_BOOKED",
    },
    select: { id: true },
  });
  if (bookedEmail) return;
  const sessions = await tx.appointmentOccurrence.findMany({
    where: {
      id: { in: placedIds },
      ...LIVE_SLOT_WHERE,
      isTentative: false,
      startsAt: { gte: new Date() },
    },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true, endsAt: true },
  });
  const first = sessions[0];
  if (!first) return;
  // Loaded on use: the allocator imports this module and must not load the email templates.
  const { stageAppointmentBookedEmail } =
    await import("@/lib/email/senders/booking");
  await stageAppointmentBookedEmail(tx, {
    appointmentId,
    consulteeUserId: learner.userId,
    consultantUserId: null,
    consulteeName: booking.consulteeName,
    consultantName: booking.consultantName,
    planTitle: booking.planTitle,
    appointmentType: eventType,
    startsAt: first.startsAt,
    calendarSession: first,
    sessions,
    dashboardUrl: notificationHref(learner.organizationId, "appointments"),
    hostDashboardUrl: notificationHref(
      booking.hostOrganizationId,
      "appointments",
    ),
  });
}

/** Each learner seat's holder in the seat's own sponsor scope. */
function seatBuyers(
  seats: readonly { organizationId: string | null; user: { id: string } }[],
): { userId: string; organizationId: string | null }[] {
  return seats.map((seat) => ({
    userId: seat.user.id,
    organizationId: seat.organizationId,
  }));
}
