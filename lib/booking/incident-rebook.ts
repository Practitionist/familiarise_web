/**
 * A learner whose 1:1 an outage voided may rebook the same expert free while
 * the remedy is open, or bring the 100 % refund forward; doing nothing refunds
 * at dueAt. The original payment pays for the rebooked session and no money moves.
 *
 * Exactly one of {rebook, refund} happens per remedy: both run under the
 * appointment lock, the rebook claims the remedy by CAS on doneAt and dueAt,
 * and the refund step re-reads doneAt under that lock.
 */

import type { Prisma } from "@prisma/client";
import type { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { intervalStartsOf } from "@/lib/appointments/occurrences";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
import { slotStartRefusal } from "@/lib/payments/utils/slot-validation";
import { stageAppointmentRescheduledEmail } from "@/lib/email/senders/booking";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { notificationHref } from "@/lib/novu/resolve-href";
import { notificationScope } from "@/lib/novu/workflows";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import type { OpenIncidentRemedySchema } from "@/schemas/appointments";
import { WEEKLY_COVERAGE_SELECT } from "@/utils/scheduling-engine/availabilityCoverage";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  lockConsulteeBooking,
  lockSlotBatch,
  unlockConsulteeBooking,
  unlockSlotInterval,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { BookingRuleError } from "./booking-rule-error";
import { createMakeUpOccurrence } from "./class-sessions";
import { lockHostTimeInTx } from "./allocation/host-time-locks";
import { incidentRefundKey, isRebookableParent } from "./incident-keys";
import { rescheduleNotificationVariant } from "./reschedule-proposals";
import { transitionConsultationRequest, transitionTrial } from "./transitions";

const HOUR_MS = 3_600_000;
/** The rebooked session must start within this many days, so the payment never sits unresolved for long. */
export const INCIDENT_REBOOK_HORIZON_DAYS = 30;

const PERSON = { select: { id: true, name: true } } as const;

const REMEDY_SELECT = {
  id: true,
  incidentId: true,
  occurrenceId: true,
  userId: true,
  paymentId: true,
  kind: true,
  dueAt: true,
  doneAt: true,
  rebookedOccurrenceId: true,
  payment: { select: { paymentIntent: true } },
  occurrence: {
    select: {
      appointmentId: true,
      ordinal: true,
      startsAt: true,
      endsAt: true,
      consultantProfileId: true,
      appointment: {
        select: {
          organizationId: true,
          consultation: {
            select: {
              id: true,
              status: true,
              requestedBy: { select: { user: PERSON } },
              consultationPlan: {
                select: {
                  title: true,
                  consultantProfileId: true,
                  consultantProfile: { select: { user: PERSON } },
                },
              },
            },
          },
          trial: {
            select: {
              id: true,
              status: true,
              paymentId: true,
              consultantProfileId: true,
              consulteeProfile: { select: { user: PERSON } },
              consultantProfile: { select: { user: PERSON } },
              subscriptionPlan: { select: { title: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.IncidentRemedySelect;

type RemedyRow = Prisma.IncidentRemedyGetPayload<{
  select: typeof REMEDY_SELECT;
}>;

/** The 1:1 the voided session belongs to: a consultation or a paid trial. */
interface VoidedBooking {
  kind: "consultation" | "trial";
  id: string;
  status: string;
  consultantProfileId: string;
  expert: { id: string; name: string | null };
  learnerName: string | null;
  title: string;
  trialPaymentId: string | null;
}

function bookingOf(remedy: RemedyRow): VoidedBooking | null {
  const { consultation, trial } = remedy.occurrence.appointment;
  if (trial) {
    return {
      kind: "trial",
      id: trial.id,
      status: trial.status,
      consultantProfileId: trial.consultantProfileId,
      expert: trial.consultantProfile.user,
      learnerName: trial.consulteeProfile.user.name,
      title: trial.subscriptionPlan.title,
      trialPaymentId: trial.paymentId,
    };
  }
  if (consultation) {
    const plan = consultation.consultationPlan;
    return {
      kind: "consultation",
      id: consultation.id,
      status: consultation.status,
      consultantProfileId: plan.consultantProfileId,
      expert: plan.consultantProfile.user,
      learnerName: consultation.requestedBy.user.name,
      title: plan.title,
      trialPaymentId: null,
    };
  }
  return null;
}

const refuse = (
  code: ConstructorParameters<typeof BookingRuleError>[0],
  message: string,
  status = 409,
) => new BookingRuleError(code, message, status);

const notFound = () =>
  refuse("INCIDENT_REMEDY_NOT_FOUND", "This remedy was not found.", 404);
const closed = () =>
  refuse(
    "INCIDENT_REMEDY_CLOSED",
    "This session was already rebooked or refunded, or its refund is now on its way.",
  );
const slotUnavailable = (message: string) =>
  refuse("INCIDENT_REBOOK_SLOT_UNAVAILABLE", message);

function readRemedy(remedyId: string): Promise<RemedyRow | null> {
  return prisma.incidentRemedy.findUnique({
    where: { id: remedyId },
    select: REMEDY_SELECT,
  });
}

/** The friendly pre-lock refusals; the CAS inside the commit is the authority. */
function assertOpenFor(
  remedy: RemedyRow | null,
  userId: string,
  now: Date,
): asserts remedy is RemedyRow {
  if (remedy?.userId !== userId) throw notFound();
  if (remedy.kind !== "REFUND_AT_DUE") {
    throw refuse(
      "INCIDENT_REMEDY_WRONG_KIND",
      "Only a 1:1 session we owe a refund for can be rebooked free.",
    );
  }
  if (remedy.doneAt || remedy.dueAt <= now) throw closed();
}

/** The new session's own refusals: on the grid, past the booking lead time, inside the horizon. */
function assertStartAllowed(startsAt: Date, now: Date): void {
  const edge = slotStartRefusal(startsAt, now);
  if (edge) throw slotUnavailable(edge.message);
  const horizon = now.getTime() + INCIDENT_REBOOK_HORIZON_DAYS * 24 * HOUR_MS;
  if (startsAt.getTime() > horizon) {
    throw slotUnavailable(
      `Pick a time within the next ${INCIDENT_REBOOK_HORIZON_DAYS} days.`,
    );
  }
}

interface RebookContext {
  remedy: RemedyRow;
  booking: VoidedBooking;
  userId: string;
  consultantProfileId: string;
  startsAt: Date;
  endsAt: Date;
}

/** The consultation validator, as the validate route and allocator run it: availability, both calendars, length. */
async function assertSlotBookable(tx: Tx, ctx: RebookContext): Promise<void> {
  const profile = await tx.consultantProfile.findUnique({
    where: { id: ctx.consultantProfileId },
    select: {
      deletedAt: true,
      scheduleType: true,
      user: { select: { id: true, timezone: true } },
      availabilityWindowsWeekly: { select: WEEKLY_COVERAGE_SELECT },
      availabilityWindowsCustom: {
        where: { startsAt: { lt: ctx.endsAt }, endsAt: { gt: ctx.startsAt } },
        select: { id: true, startsAt: true, endsAt: true },
      },
    },
  });
  const expert = ctx.booking.expert.name ?? "Your expert";
  if (!profile || profile.deletedAt) {
    throw slotUnavailable(`${expert} is no longer taking bookings.`);
  }
  const result = await new ScheduleValidationService(tx).validate(
    "consultation",
    ctx.booking.id,
    intervalStartsOf(ctx),
    {
      userId: profile.user.id,
      scheduleType: profile.scheduleType,
      availabilityWindowsWeekly: profile.availabilityWindowsWeekly,
      availabilityWindowsCustom: profile.availabilityWindowsCustom,
      timezone: profile.user.timezone || undefined,
    },
    {
      durationInHours:
        (ctx.endsAt.getTime() - ctx.startsAt.getTime()) / HOUR_MS,
    },
    undefined,
    {
      consulteeUserId: ctx.userId,
      consultantProfileId: ctx.consultantProfileId,
    },
  );
  if (result.isValid) return;
  throw slotUnavailable(
    result.conflicts?.length
      ? "That time is no longer free for both of you. Pick another time."
      : `That time is outside ${expert}'s published availability. Pick a green time.`,
  );
}

/** A refund the sweep already stamped or issued under this remedy's key wins over the rebook. */
async function assertNoIncidentRefund(
  tx: Tx,
  remedy: RemedyRow,
): Promise<void> {
  const key = incidentRefundKey(
    remedy.incidentId,
    remedy.occurrenceId,
    remedy.userId,
  );
  const marker = remedy.paymentId
    ? await tx.payment.findUnique({
        where: { id: remedy.paymentId },
        select: { refundOwedKey: true },
      })
    : null;
  const refund = await tx.refund.findUnique({
    where: { dedupeKey: key },
    select: { id: true },
  });
  if (marker?.refundOwedKey === key || refund) throw closed();
}

/** A completed booking reopens (a 1:1 to APPROVED, a trial to SCHEDULED) so the rebooked session completes and cancels normally. */
async function reopenBooking(
  tx: Tx,
  ctx: RebookContext,
  now: Date,
): Promise<void> {
  const { booking } = ctx;
  const meta = {
    actorUserId: ctx.userId,
    reason: `incident-rebook:${ctx.remedy.id}`,
    appointmentId: ctx.remedy.occurrence.appointmentId,
    at: now,
  };
  const live =
    booking.kind === "trial"
      ? await tx.trial.findUnique({
          where: { id: booking.id },
          select: { status: true },
        })
      : await tx.consultation.findUnique({
          where: { id: booking.id },
          select: { status: true },
        });
  if (!live || !isRebookableParent(booking.kind, live.status)) throw closed();
  // A confirmed booking stays as it is; only a completed one reopens.
  if (live.status !== "COMPLETED") return;
  if (booking.kind === "consultation") {
    await transitionConsultationRequest(tx, {
      ...meta,
      where: { id: booking.id },
      to: "APPROVED",
      fromIn: ["COMPLETED"],
    });
    return;
  }
  // COMPLETED → SCHEDULED is this door's own edge; the shared map keeps the route's set.
  await transitionTrial(tx, {
    ...meta,
    where: { id: booking.id },
    to: "SCHEDULED",
    fromIn: ["COMPLETED"],
    data: { completedAt: null },
  });
  if (!booking.trialPaymentId) return;
  // Completion started the paid trial's earnings hold; the rebooked session's completion starts it again.
  const stamped = {
    paymentId: booking.trialPaymentId,
    status: "PENDING" as const,
    holdUntil: { not: null },
  };
  await tx.consultantEarnings.updateMany({
    where: stamped,
    data: { holdUntil: null },
  });
  await tx.organizationEarnings.updateMany({
    where: stamped,
    data: { holdUntil: null },
  });
}

/**
 * One commit: claim the remedy, settle the voided session as made up, place
 * the new session on the same appointment and payment, reopen the booking and
 * move the earnings hold to the new session's end. No earning is written.
 */
async function commitRebook(
  tx: Tx,
  ctx: RebookContext,
): Promise<{ occurrenceId: string }> {
  const now = new Date();
  const { remedy } = ctx;
  const voided = remedy.occurrence;
  const claim = await tx.incidentRemedy.updateMany({
    where: {
      id: remedy.id,
      userId: ctx.userId,
      kind: "REFUND_AT_DUE",
      doneAt: null,
      dueAt: { gt: now },
    },
    data: { doneAt: now },
  });
  if (claim.count === 0) throw closed();
  // The make-up settles the miss, so the day-14 sweep never refunds it and the earning may release.
  const settled = await tx.appointmentOccurrence.updateMany({
    where: {
      id: remedy.occurrenceId,
      completionStatus: "VOIDED",
      seatsSettledAt: null,
      deletedAt: null,
    },
    data: { seatsSettledAt: now },
  });
  if (settled.count === 0) throw closed();
  await assertNoIncidentRefund(tx, remedy);
  await assertSlotBookable(tx, ctx);
  let created: { id: string };
  try {
    created = await createMakeUpOccurrence(tx, {
      appointmentId: voided.appointmentId,
      ordinal: voided.ordinal,
      startsAt: ctx.startsAt,
      endsAt: ctx.endsAt,
      consultantProfileId: ctx.consultantProfileId,
      movedAt: null,
    });
  } catch (error) {
    if (
      error instanceof BookingRuleError &&
      error.code === "SCHEDULE_CONFLICT"
    ) {
      throw refuse(
        "SCHEDULE_CONFLICT",
        `${ctx.booking.expert.name ?? "Your expert"} is no longer free at that time. Pick another time.`,
      );
    }
    throw error;
  }
  await tx.incidentRemedy.update({
    where: { id: remedy.id },
    data: { rebookedOccurrenceId: created.id },
  });
  await reopenBooking(tx, ctx, now);
  await recomputeEarningsHold(tx, voided.appointmentId);
  return { occurrenceId: created.id };
}

/** Both sides hear "moved" through the existing reschedule bell and email. */
async function notifyRebooked(ctx: RebookContext): Promise<void> {
  const { remedy, booking } = ctx;
  const appointmentId = remedy.occurrence.appointmentId;
  const organizationId = remedy.occurrence.appointment.organizationId;
  const appointmentType = booking.kind;
  const userIds = [...new Set([booking.expert.id, ctx.userId])];
  // The move confirmed itself: the party who did not rebook hears it whatever their switches say.
  const others = userIds.filter((id) => id !== ctx.userId);
  const dashboardUrl = notificationHref(organizationId, "appointments");
  const variant = rescheduleNotificationVariant({
    releasedAt: remedy.occurrence.startsAt,
    proposedAt: ctx.startsAt,
    autoConfirmed: true,
  });
  const [bells, emails] = await Promise.all([
    notifyAppointmentRescheduled(
      userIds,
      {
        ...notificationScope(organizationId),
        ...variant,
        appointmentId,
        appointmentType,
        consultantName: booking.expert.name ?? "Consultant",
        consulteeName: booking.learnerName ?? "Participant",
        planTitle: planTitleOrSessionLabel(booking.title, appointmentType),
        dashboardUrl,
      },
      {
        deferAttempt: true,
        required: { kind: "MOVE_AUTO_CONFIRMED", recipients: others },
      },
    ).catch((error: unknown) => {
      console.error("[incident-rebook] Failed to stage the bell:", error);
      return [];
    }),
    stageAppointmentRescheduledEmail(prisma, {
      appointmentId,
      userIds,
      outcome: "MOVED",
      appointmentType,
      oldStartsAt: remedy.occurrence.startsAt,
      newStartsAt: ctx.startsAt,
      requiredFor: others,
      dashboardUrl,
    }).catch((error: unknown) => {
      console.error("[incident-rebook] Failed to stage the email:", error);
      return [];
    }),
  ]);
  await flushNotificationsAfter(
    {
      bells: (bells ?? []).map((r) => r?.staged),
      emails: [{ rows: emails, emailType: "APPOINTMENT_RESCHEDULED" }],
    },
    "incident-rebook",
  );
}

/** Rebooks the voided session free at `startsAt`, at its own length, with the same expert. */
export async function rebookIncidentRemedy(args: {
  remedyId: string;
  userId: string;
  startsAt: Date;
}): Promise<{ occurrenceId: string; startsAt: string; endsAt: string }> {
  const now = new Date();
  const remedy = await readRemedy(args.remedyId);
  assertOpenFor(remedy, args.userId, now);
  const booking = bookingOf(remedy);
  if (!booking || !isRebookableParent(booking.kind, booking.status))
    throw closed();
  assertStartAllowed(args.startsAt, now);
  const voided = remedy.occurrence;
  const ctx: RebookContext = {
    remedy,
    booking,
    userId: args.userId,
    consultantProfileId:
      voided.consultantProfileId ?? booking.consultantProfileId,
    startsAt: args.startsAt,
    endsAt: new Date(
      args.startsAt.getTime() +
        (voided.endsAt.getTime() - voided.startsAt.getTime()),
    ),
  };
  // A learner who is also an expert holds their own calendar's atoms too.
  const buyerProfile = await prisma.consultantProfile.findUnique({
    where: { userId: args.userId },
    select: { id: true },
  });
  const slotProfileIds = [ctx.consultantProfileId, buyerProfile?.id].filter(
    (id, i, all): id is string => !!id && all.indexOf(id) === i,
  );
  // Global lock order: appointment, then consultee, then one all-or-nothing slot batch.
  const committed = await withAppointmentLock(
    voided.appointmentId,
    async () => {
      const consulteeLock = await lockConsulteeBooking(args.userId);
      try {
        const slotEntries = slotProfileIds.map((consultantProfileId) => ({
          consultantProfileId,
          startsAt: ctx.startsAt,
          endsAt: ctx.endsAt,
        }));
        const slotLocks = await lockSlotBatch(slotEntries);
        try {
          return await prisma.$transaction(
            async (tx) => {
              await lockHostTimeInTx(tx, slotEntries, () =>
                slotUnavailable(
                  "That time is no longer free for both of you. Pick another time.",
                ),
              );
              return commitRebook(tx, ctx);
            },
            { timeout: 15_000 },
          );
        } finally {
          await unlockSlotInterval(slotLocks);
        }
      } finally {
        await unlockConsulteeBooking(consulteeLock);
      }
    },
  );
  await notifyRebooked(ctx);
  return {
    occurrenceId: committed.occurrenceId,
    startsAt: ctx.startsAt.toISOString(),
    endsAt: ctx.endsAt.toISOString(),
  };
}

/**
 * Brings the refund forward: dueAt moves to now by CAS, so the next settle run
 * refunds it. A repeat, or a remedy already due or refunded, answers the same.
 */
export async function bringIncidentRefundForward(args: {
  remedyId: string;
  userId: string;
}): Promise<{ incidentId: string; dueAt: string; refunded: boolean }> {
  const now = new Date();
  const remedy = await readRemedy(args.remedyId);
  if (remedy?.userId !== args.userId) throw notFound();
  if (remedy.kind !== "REFUND_AT_DUE") {
    throw refuse(
      "INCIDENT_REMEDY_WRONG_KIND",
      "This session's remedy is not a refund that can be brought forward.",
    );
  }
  const { count } = await prisma.incidentRemedy.updateMany({
    where: {
      id: remedy.id,
      userId: args.userId,
      kind: "REFUND_AT_DUE",
      doneAt: null,
      dueAt: { gt: now },
    },
    data: { dueAt: now },
  });
  const after =
    count > 0
      ? {
          dueAt: now,
          doneAt: null,
          lastError: null,
          rebookedOccurrenceId: null,
        }
      : await prisma.incidentRemedy.findUniqueOrThrow({
          where: { id: remedy.id },
          select: {
            dueAt: true,
            doneAt: true,
            lastError: true,
            rebookedOccurrenceId: true,
          },
        });
  if (after.rebookedOccurrenceId) throw closed();
  return {
    incidentId: remedy.incidentId,
    dueAt: after.dueAt.toISOString(),
    // A remedy closed with a note was skipped, not refunded.
    refunded: after.doneAt !== null && after.lastError === null,
  };
}

type OpenIncidentRemedy = z.infer<typeof OpenIncidentRemedySchema>;

/** The caller's remedies still open to a free rebook, soonest refund first. */
export async function readOpenIncidentRemedies(
  userId: string,
  appointmentId?: string,
): Promise<OpenIncidentRemedy[]> {
  const rows = await prisma.incidentRemedy.findMany({
    where: {
      userId,
      kind: "REFUND_AT_DUE",
      doneAt: null,
      dueAt: { gt: new Date() },
      ...(appointmentId ? { occurrence: { appointmentId } } : {}),
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 20,
    select: REMEDY_SELECT,
  });
  return rows.flatMap((row) => {
    const booking = bookingOf(row);
    if (!booking || !isRebookableParent(booking.kind, booking.status))
      return [];
    return [
      {
        id: row.id,
        appointmentId: row.occurrence.appointmentId,
        sessionStartsAt: row.occurrence.startsAt.toISOString(),
        sessionEndsAt: row.occurrence.endsAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        title: booking.title,
        expertName: booking.expert.name,
        fundingRail: fundingRailForIntent(row.payment?.paymentIntent),
      },
    ];
  });
}
