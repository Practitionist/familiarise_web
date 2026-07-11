/**
 * Moderation bulk-cancel (#693): cancel every future engagement a suspended
 * or banned user is part of, with 100% refunds to the innocent counterparty —
 * moderation is platform-initiated, so booking-time policy tiers do not apply.
 *
 * Mirrors the CAS doctrine of app/api/appointments/[appointmentId]/cancel:
 * status moves ride a guarded updateMany (double-cancel loses the CAS and is
 * skipped), refunds run AFTER each cancel commits because refundPayment owns
 * its own Serializable tx. Every step is idempotent, so a re-run after a
 * partial failure (or budget exhaustion) is safe.
 */
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { refundPayment } from "@/lib/payments/operations/refund";
import { handleSlotOpening } from "@/lib/waitlist";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
} from "@/lib/booking/transitions";

export interface BulkCancelSummary {
  engagementsCancelled: number;
  attendeeRemovals: number;
  refundsIssued: number;
  refundedPaise: number;
  failures: Array<{ kind: string; id: string; error: string }>;
  /** Work items not reached inside the time budget — safe to re-run. */
  remaining: Array<{ kind: string; id: string }>;
}

interface BulkCancelOptions {
  initiatedByUserId: string;
  notes?: string;
  /** Netlify functions are wall-clock capped; leave headroom for the rest
   *  of the best-effort phase. */
  budgetMs?: number;
}

type WorkItem =
  | { kind: "consultation" | "subscription"; id: string }
  | { kind: "webinar-event" | "class-event"; id: string }
  | { kind: "webinar-attendance" | "class-attendance"; id: string };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function cancelFutureEngagementsForUser(
  targetUserId: string,
  { initiatedByUserId, notes, budgetMs = 15_000 }: BulkCancelOptions,
): Promise<BulkCancelSummary> {
  const deadline = Date.now() + budgetMs;
  const summary: BulkCancelSummary = {
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    remaining: [],
  };

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { consulteeProfileId: true, consultantProfileId: true },
  });
  if (!target) return summary;

  const futureSlot = {
    completionStatus: "SCHEDULED" as const,
    startsAt: { gt: new Date() },
  };

  const work: WorkItem[] = [];

  if (target.consulteeProfileId) {
    const [consultations, subscriptions, attendedSlots] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          requestedById: target.consulteeProfileId,
          status: { in: [...CANCELLABLE_FROM] },
          appointment: { slotsOfAppointment: { some: futureSlot } },
        },
        select: { id: true },
      }),
      prisma.subscription.findMany({
        where: {
          requestedById: target.consulteeProfileId,
          status: { in: [...CANCELLABLE_FROM] },
          appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
        },
        select: { id: true },
      }),
      // Group events the target merely attends — remove + refund just them.
      prisma.slotOfAppointment.findMany({
        where: {
          ...futureSlot,
          user: { some: { id: targetUserId } },
          appointment: {
            OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
          },
        },
        select: {
          appointment: { select: { webinarId: true, classId: true } },
        },
      }),
    ]);
    work.push(
      ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
      ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
    );
    const webinarIds = new Set<string>();
    const classIds = new Set<string>();
    for (const slot of attendedSlots) {
      if (slot.appointment?.webinarId) webinarIds.add(slot.appointment.webinarId);
      if (slot.appointment?.classId) classIds.add(slot.appointment.classId);
    }
    work.push(
      ...Array.from(webinarIds, (id) => ({
        kind: "webinar-attendance" as const,
        id,
      })),
      ...Array.from(classIds, (id) => ({
        kind: "class-attendance" as const,
        id,
      })),
    );
  }

  if (target.consultantProfileId) {
    const [consultations, subscriptions, webinars, classes] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          consultationPlan: { consultantProfileId: target.consultantProfileId },
          status: { in: [...CANCELLABLE_FROM] },
          appointment: { slotsOfAppointment: { some: futureSlot } },
        },
        select: { id: true },
      }),
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: { consultantProfileId: target.consultantProfileId },
          status: { in: [...CANCELLABLE_FROM] },
          appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
        },
        select: { id: true },
      }),
      prisma.webinar.findMany({
        where: {
          webinarPlan: { consultantProfileId: target.consultantProfileId },
          status: { in: EVENT_ALLOWED_FROM.CANCELLED },
          appointment: { slotsOfAppointment: { some: futureSlot } },
        },
        select: { id: true },
      }),
      prisma.class.findMany({
        where: {
          classPlan: { consultantProfileId: target.consultantProfileId },
          status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
          appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
        },
        select: { id: true },
      }),
    ]);
    work.push(
      ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
      ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
      ...webinars.map((w) => ({ kind: "webinar-event" as const, id: w.id })),
      ...classes.map((c) => ({ kind: "class-event" as const, id: c.id })),
    );
  }

  for (let i = 0; i < work.length; i++) {
    if (Date.now() > deadline) {
      summary.remaining = work.slice(i);
      Sentry.captureMessage(
        `[moderation] bulk-cancel budget exhausted for user ${targetUserId}; ${summary.remaining.length} engagement(s) left — re-run the action to finish`,
        { tags: { subsystem: "moderation" } },
      );
      break;
    }
    const item = work[i];
    try {
      switch (item.kind) {
        case "consultation":
        case "subscription":
          await cancelExclusiveEngagement(item.kind, item.id, {
            initiatedByUserId,
            notes,
            summary,
          });
          break;
        case "webinar-event":
        case "class-event":
          await cancelGroupEvent(item.kind, item.id, {
            initiatedByUserId,
            summary,
          });
          break;
        case "webinar-attendance":
        case "class-attendance":
          await removeAttendee(item.kind, item.id, targetUserId, {
            initiatedByUserId,
            summary,
          });
          break;
      }
    } catch (error) {
      summary.failures.push({ kind: item.kind, id: item.id, error: errMsg(error) });
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
  }

  return summary;
}

interface NormalizedEngagement {
  planTitle?: string;
  consultantUser?: { id: string; name: string | null } | null;
  consulteeUser?: { id: string; name: string | null } | null;
  appointments: Array<{
    id: string;
    appointmentType: string;
    // amount is number at runtime — the extended client converts BigInt on read
    payment: Array<{ id: string; amount: number; paymentStatus: string }>;
  }>;
}

async function cancelExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
  ctx: { initiatedByUserId: string; notes?: string; summary: BulkCancelSummary },
) {
  const planSelect = {
    select: {
      title: true,
      consultantProfile: {
        select: { user: { select: { id: true, name: true } } },
      },
    },
  } as const;
  const requestedBySelect = {
    select: { user: { select: { id: true, name: true } } },
  } as const;
  const appointmentSelect = {
    select: {
      id: true,
      appointmentType: true,
      payment: { select: { id: true, amount: true, paymentStatus: true } },
    },
  } as const;

  let engagement: NormalizedEngagement | null = null;
  if (kind === "consultation") {
    const row = await prisma.consultation.findUnique({
      where: { id: engagementId },
      select: {
        consultationPlan: planSelect,
        requestedBy: requestedBySelect,
        appointment: appointmentSelect,
      },
    });
    if (row) {
      engagement = {
        planTitle: row.consultationPlan?.title,
        consultantUser: row.consultationPlan?.consultantProfile?.user,
        consulteeUser: row.requestedBy?.user,
        appointments: row.appointment ? [row.appointment] : [],
      };
    }
  } else {
    const row = await prisma.subscription.findUnique({
      where: { id: engagementId },
      select: {
        subscriptionPlan: planSelect,
        requestedBy: requestedBySelect,
        appointments: appointmentSelect,
      },
    });
    if (row) {
      engagement = {
        planTitle: row.subscriptionPlan?.title,
        consultantUser: row.subscriptionPlan?.consultantProfile?.user,
        consulteeUser: row.requestedBy?.user,
        appointments: row.appointments,
      };
    }
  }
  if (!engagement) return;

  const cancellationData = {
    status: "CANCELLED" as const,
    cancellationReason: "MODERATION" as const,
    cancellationNotes: ctx.notes ?? null,
    cancelledAt: new Date(),
    cancelledBy: ctx.initiatedByUserId,
  };

  const moved = await prisma.$transaction(async (tx) => {
    const res =
      kind === "consultation"
        ? await tx.consultation.updateMany({
            where: { id: engagementId, status: { in: [...CANCELLABLE_FROM] } },
            data: cancellationData,
          })
        : await tx.subscription.updateMany({
            where: { id: engagementId, status: { in: [...CANCELLABLE_FROM] } },
            data: cancellationData,
          });
    if (res.count === 0) return 0;
    await tx.slotOfAppointment.updateMany({
      where:
        kind === "consultation"
          ? {
              appointment: { consultationId: engagementId },
              completionStatus: "SCHEDULED",
            }
          : {
              appointment: { subscriptionId: engagementId },
              completionStatus: "SCHEDULED",
            },
      data: { completionStatus: "CANCELLED" },
    });
    return res.count;
  });
  if (moved === 0) return; // lost the CAS — already terminal, no refund

  ctx.summary.engagementsCancelled += 1;

  for (const appt of engagement.appointments) {
    const paid = appt.payment.find(
      (p) => p.paymentStatus === "SUCCEEDED" && p.amount > 0,
    );
    if (paid) {
      await issueFullRefund(paid.id, ctx.initiatedByUserId, ctx.summary);
    }
  }

  const userIds = [
    engagement.consultantUser?.id,
    engagement.consulteeUser?.id,
  ].filter((id): id is string => !!id);
  if (userIds.length > 0) {
    void notifyAppointmentCancelled(userIds, {
      appointmentType:
        engagement.appointments[0]?.appointmentType ?? kind.toUpperCase(),
      consultantName: engagement.consultantUser?.name || "Consultant",
      consulteeName: engagement.consulteeUser?.name || "Consultee",
      planTitle: engagement.planTitle || "N/A",
      dashboardUrl: "/dashboard",
      reason: "MODERATION",
      cancelledBy: "system",
    });
  }
}

async function cancelGroupEvent(
  kind: "webinar-event" | "class-event",
  eventId: string,
  ctx: { initiatedByUserId: string; summary: BulkCancelSummary },
) {
  const isWebinar = kind === "webinar-event";

  const moved = await prisma.$transaction(async (tx) => {
    const res = isWebinar
      ? await tx.webinar.updateMany({
          where: { id: eventId, status: { in: EVENT_ALLOWED_FROM.CANCELLED } },
          data: { status: "CANCELLED" },
        })
      : await tx.class.updateMany({
          where: {
            id: eventId,
            status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
          },
          data: { status: "CANCELLED" },
        });
    if (res.count === 0) return 0;
    await tx.slotOfAppointment.updateMany({
      where: {
        appointment: isWebinar ? { webinarId: eventId } : { classId: eventId },
        completionStatus: "SCHEDULED",
      },
      data: { completionStatus: "CANCELLED" },
    });
    return res.count;
  });
  if (moved === 0) return;

  ctx.summary.engagementsCancelled += 1;

  // Whole-event moderation cancel refunds EVERY attendee in full — unlike the
  // consultant-initiated cancel route, which defers buyer refunds to the
  // participant-removal flow.
  const payments = await prisma.payment.findMany({
    where: {
      appointment: isWebinar ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: { id: true, userId: true },
  });
  for (const payment of payments) {
    await issueFullRefund(payment.id, ctx.initiatedByUserId, ctx.summary);
  }

  const attendeeIds = Array.from(new Set(payments.map((p) => p.userId)));
  if (attendeeIds.length > 0) {
    void notifyAppointmentCancelled(attendeeIds, {
      appointmentType: isWebinar ? "WEBINAR" : "CLASS",
      consultantName: "Consultant",
      consulteeName: "Attendee",
      planTitle: "N/A",
      dashboardUrl: "/dashboard",
      reason: "MODERATION",
      cancelledBy: "system",
    });
  }
}

async function removeAttendee(
  kind: "webinar-attendance" | "class-attendance",
  eventId: string,
  targetUserId: string,
  ctx: { initiatedByUserId: string; summary: BulkCancelSummary },
) {
  const isWebinar = kind === "webinar-attendance";
  const eventFilter = isWebinar ? { webinarId: eventId } : { classId: eventId };

  const slots = await prisma.slotOfAppointment.findMany({
    where: {
      appointment: eventFilter,
      completionStatus: "SCHEDULED",
      startsAt: { gt: new Date() },
      user: { some: { id: targetUserId } },
    },
    select: { id: true },
  });
  if (slots.length === 0) return;

  await prisma.$transaction(
    slots.map((slot) =>
      prisma.slotOfAppointment.update({
        where: { id: slot.id },
        data: { user: { disconnect: { id: targetUserId } } },
      }),
    ),
  );
  ctx.summary.attendeeRemovals += 1;

  const paid = await prisma.payment.findFirst({
    where: {
      userId: targetUserId,
      appointment: eventFilter,
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: { id: true },
  });
  if (paid) {
    await issueFullRefund(paid.id, ctx.initiatedByUserId, ctx.summary);
  }

  try {
    await handleSlotOpening({
      ...(isWebinar ? { webinarId: eventId } : { classId: eventId }),
      slotsAvailable: 1,
      reason: "participant_removed",
    });
  } catch (error) {
    // Waitlist promotion is opportunistic — the removal itself stands.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
  }
}

async function issueFullRefund(
  paymentId: string,
  initiatedByUserId: string,
  summary: BulkCancelSummary,
) {
  try {
    const r = await refundPayment({
      paymentId,
      // amountPaise omitted → refundPayment refunds the full refundable balance
      reason: "moderation (100% — platform-initiated cancellation)",
      initiatedByUserId,
    });
    summary.refundsIssued += 1;
    summary.refundedPaise += r.amountRefundedPaise;
  } catch (error) {
    summary.failures.push({
      kind: "refund",
      id: paymentId,
      error: errMsg(error),
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
  }
}
