// Stages the booked and partially-scheduled notices inside the allocation
// transaction; the caller attempts them after commit.

import { liveParticipant } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { EventType } from "@/utils/scheduling-engine/types";
import type { ApprovalOutcome } from "@/lib/booking/approve-request";
import {
  notifyAppointmentBooked,
  notifyAppointmentPartiallyScheduled,
  type StagedTrigger,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";

/**
 * PR 2c — fire-and-forget APPOINTMENT_BOOKED to both parties once real
 * times exist. Completes the B9 story: payment skipped this notification
 * for slot-less bookings on purpose.
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
  /** The sessions this run placed; each batch is its own notice, never deduplicated into an earlier one. */
  placedStarts: readonly Date[] = [],
): Promise<StagedTrigger[]> {
  // #1775 B-9 — nothing is booked before payment: an awaiting-payment
  // approval's only consultee message is the pay-link email the mint sends.
  if (outcome === "awaiting_payment") return [];
  const prisma = tx;
  // A top-up or reallocation keeps past and cancelled rows; the notice names the next live one.
  const nextLiveSession = {
    ...LIVE_SLOT_WHERE,
    isTentative: false,
    startsAt: { gte: new Date() },
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
  let context: {
    userIds: string[];
    // #1206 — the partial notice goes to these only; the consultant was
    // already shown the shortfall and confirmed it.
    consulteeUserIds: string[];
    consultantName: string;
    consulteeName: string;
    planTitle: string;
    firstStart: Date | null;
    organizationId: string | null;
    appointmentId?: string;
  } | null = null;

  if (eventType === "consultation") {
    const row = await prisma.consultation.findUnique({
      where: { id: eventId },
      select: {
        consultationPlan: {
          select: {
            title: true,
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
      userIds: [
        row.consultationPlan.consultantProfile.user.id,
        row.requestedBy.user.id,
      ].filter(Boolean),
      consulteeUserIds: [row.requestedBy.user.id].filter(Boolean),
      consultantName:
        row.consultationPlan.consultantProfile.user.name || "Consultant",
      consulteeName: row.requestedBy.user.name || "Consultee",
      planTitle: row.consultationPlan.title,
      firstStart: row.appointment.occurrences[0]?.startsAt ?? null,
      organizationId: row.appointment.organizationId,
      appointmentId: row.appointment.id,
    };
  } else if (eventType === "subscription") {
    const row = await prisma.subscription.findUnique({
      where: { id: eventId },
      select: {
        subscriptionPlan: {
          select: {
            title: true,
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
      userIds: [
        row.subscriptionPlan.consultantProfile.user.id,
        row.requestedBy.user.id,
      ].filter(Boolean),
      consulteeUserIds: [row.requestedBy.user.id].filter(Boolean),
      consultantName:
        row.subscriptionPlan.consultantProfile.user.name || "Consultant",
      consulteeName: row.requestedBy.user.name || "Consultee",
      planTitle: row.subscriptionPlan.title,
      firstStart: row.appointment.occurrences[0]?.startsAt ?? null,
      organizationId: row.appointment.organizationId,
      appointmentId: row.appointment.id,
    };
  } else if (eventType === "webinar") {
    const row = await prisma.webinar.findUnique({
      where: { id: eventId },
      select: {
        webinarPlan: {
          select: {
            title: true,
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
              where: liveParticipant(),
              select: { user: { select: { id: true, name: true } } },
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
      userIds: [hostUser.id, ...userMap.keys()],
      consulteeUserIds: [...userMap.keys()],
      consultantName: hostUser.name || "Consultant",
      consulteeName:
        userMap.size === 1
          ? [...userMap.values()][0]
          : `${userMap.size} attendees`,
      planTitle: plan.title,
      firstStart,
      organizationId: row.appointment.organizationId,
      appointmentId: row.appointment.id,
    };
  } else {
    const row = await prisma.class.findUnique({
      where: { id: eventId },
      select: {
        classPlan: {
          select: {
            title: true,
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
              where: liveParticipant(),
              select: { user: { select: { id: true, name: true } } },
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
      userIds: [host.id, ...userMap.keys()],
      consulteeUserIds: [...userMap.keys()],
      consultantName: host.name || "Consultant",
      consulteeName:
        userMap.size === 1
          ? [...userMap.values()][0]
          : `${userMap.size} attendees`,
      planTitle: plan.title,
      firstStart,
      organizationId: appts[0]!.organizationId,
      appointmentId: appts[0]!.id,
    };
  }

  if (!context || context.userIds.length === 0) return [];

  const payload = {
    ...notificationScope(context.organizationId),
    appointmentId: context.appointmentId,
    dateTime: context.firstStart?.toISOString(),
    appointmentType: eventType,
    consultantName: context.consultantName,
    consulteeName: context.consulteeName,
    planTitle: context.planTitle,
    dashboardUrl: notificationHref(context.organizationId, "appointments"),
  };

  const placedKeys = placedStarts
    .map((start) => new Date(start).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const dedupeKey =
    placedKeys.length > 0
      ? `allocation:${context.appointmentId ?? eventId}:${placedKeys.join(",")}`
      : undefined;
  const results = await notifyAppointmentBooked(context.userIds, payload, {
    tx,
    dedupeKey,
  });

  // #1206 — a second, separate notice rather than a flag on the booking one:
  // the times that WERE placed are a real booking and read as one, and the
  // thing the consultee has to be told is what happened to the rest.
  if (partial?.partial && context.consulteeUserIds.length > 0) {
    results.push(
      ...(await notifyAppointmentPartiallyScheduled(
        context.consulteeUserIds,
        {
          ...payload,
          placedSessions: partial.placedSessions ?? 0,
          requiredSessions: partial.requiredSessions ?? 0,
          unplacedSessions: partial.unplacedSessions ?? 0,
        },
        { tx, dedupeKey },
      )),
    );
  }
  return results.flatMap((r) => (r.staged ? [r.staged] : []));
}
