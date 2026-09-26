import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  MAKEUP_WINDOW_DAYS,
  UNSETTLED_MISS,
  missedAt,
} from "@/lib/booking/misses";
import { readRequestsInboxCounts } from "@/lib/data/requests-inbox";

/**
 * #1527 §7.2 — the consultant Home's "Needs you" strip: only what is blocked
 * on this consultant, each with one next click. Attestation is gone (#1569
 * decides outcomes); owed make-ups and reschedule replies took its place.
 * Reads run in sequence under PG_POOL_MAX=1.
 */

export interface ConsultantNeedsYou {
  /** The Requests badge's own number (#1345): the inbox tab counts, summed. */
  requestsToAnswer: number;
  /** A learner proposed new times and waits on this consultant (#1163). */
  rescheduleReplies: { appointmentId: string; counterpartName: string }[];
  /** #1569 — a host-cancelled or voided class session with no make-up yet. */
  owedMakeUps: {
    appointmentId: string;
    occurrenceId: string;
    title: string;
    /** Made up and HELD by this instant, or every seat is refunded one unit. */
    deadline: string;
  }[];
  /** Learner uploads waiting on this consultant's review. */
  documentsAwaitingReview: number;
}

const DAY_MS = 86_400_000;
const LIST_TAKE = 5;

/** Personal (non-org) 1:1 and subscription bookings this consultant delivers. */
const personalOneToOne = (
  consultantProfileId: string,
): Prisma.AppointmentWhereInput => ({
  organizationId: null,
  OR: [
    { consultation: { consultationPlan: { consultantProfileId } } },
    { subscription: { subscriptionPlan: { consultantProfileId } } },
  ],
});

async function readRescheduleReplies(consultantProfileId: string) {
  const rows = await prisma.rescheduleRequest.findMany({
    where: {
      // Propose → accept or decline is the whole flow; COUNTERED is never written.
      status: "PENDING_REVIEW",
      initiatorRole: "CONSULTEE",
      deletedAt: null,
      appointment: personalOneToOne(consultantProfileId),
    },
    orderBy: { createdAt: "asc" },
    take: LIST_TAKE,
    select: { appointmentId: true, initiatedBy: { select: { name: true } } },
  });
  return rows.map((r) => ({
    appointmentId: r.appointmentId,
    counterpartName: r.initiatedBy?.name ?? "A learner",
  }));
}

/**
 * The same pairing the class detail uses (ClassSessionControls): a miss is
 * owed until a live occurrence with its ordinal exists or the sweep settles
 * its seats; the window runs 14 days from the miss.
 */
async function readOwedMakeUps(consultantProfileId: string, now: Date) {
  const misses = await prisma.appointmentOccurrence.findMany({
    where: {
      ...UNSETTLED_MISS,
      appointment: {
        organizationId: null,
        class: { classPlan: { consultantProfileId } },
      },
    },
    orderBy: { startsAt: "asc" },
    take: 20,
    select: {
      id: true,
      appointmentId: true,
      ordinal: true,
      hostCancelledAt: true,
      voidedAt: true,
      appointment: {
        select: {
          class: { select: { classPlan: { select: { title: true } } } },
        },
      },
    },
  });
  if (misses.length === 0) return [];

  const madeUp = await prisma.appointmentOccurrence.findMany({
    where: {
      appointmentId: { in: misses.map((m) => m.appointmentId) },
      id: { notIn: misses.map((m) => m.id) },
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED", "VOIDED"] },
    },
    select: { appointmentId: true, ordinal: true },
  });
  const covered = new Set(madeUp.map((o) => `${o.appointmentId}:${o.ordinal}`));

  return misses
    .flatMap((miss) => {
      const at = missedAt(miss);
      if (!at || covered.has(`${miss.appointmentId}:${miss.ordinal}`))
        return [];
      const deadline = new Date(at.getTime() + MAKEUP_WINDOW_DAYS * DAY_MS);
      if (deadline <= now) return [];
      return [
        {
          appointmentId: miss.appointmentId,
          occurrenceId: miss.id,
          title: miss.appointment.class?.classPlan.title ?? "Class session",
          deadline: deadline.toISOString(),
        },
      ];
    })
    .slice(0, LIST_TAKE);
}

export async function readConsultantNeedsYou(
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<ConsultantNeedsYou> {
  const counts = await readRequestsInboxCounts({ consultantProfileId, now });
  const rescheduleReplies = await readRescheduleReplies(consultantProfileId);
  const owedMakeUps = await readOwedMakeUps(consultantProfileId, now);
  const documentsAwaitingReview = await prisma.appointmentDocument.count({
    where: {
      deletedAt: null,
      uploadedByRole: "CONSULTEE",
      reviewStatus: "PENDING",
      appointment: personalOneToOne(consultantProfileId),
    },
  });
  return {
    requestsToAnswer: Object.values(counts).reduce((sum, n) => sum + n, 0),
    rescheduleReplies,
    owedMakeUps,
    documentsAwaitingReview,
  };
}

/** Every booking arm this consultant delivers, personal or org-funded. */
const deliveredBy = (
  consultantProfileId: string,
): Prisma.AppointmentWhereInput => ({
  OR: [
    { consultation: { consultationPlan: { consultantProfileId } } },
    { subscription: { subscriptionPlan: { consultantProfileId } } },
    { webinar: { webinarPlan: { consultantProfileId } } },
    { class: { classPlan: { consultantProfileId } } },
  ],
});

/** #1527 — Home's "This month" card and its one milestone line; no engine. */
export async function readSessionsDelivered(
  consultantProfileId: string,
  startOfMonth: Date,
): Promise<{ thisMonth: number; lifetime: number }> {
  const where: Prisma.AppointmentOccurrenceWhereInput = {
    completionStatus: "COMPLETED",
    deletedAt: null,
    appointment: deliveredBy(consultantProfileId),
  };
  const lifetime = await prisma.appointmentOccurrence.count({ where });
  const thisMonth = await prisma.appointmentOccurrence.count({
    where: { ...where, startsAt: { gte: startOfMonth } },
  });
  return { thisMonth, lifetime };
}
