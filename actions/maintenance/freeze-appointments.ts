/** Explicitly confirmed whole-booking cancellation with durable refund and notice obligations. */

import { STAFF_CANCEL_REFUND_REASON } from "@/lib/payments/operations/refund-cause";
import { Prisma } from "@prisma/client";

import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  heldInsteadOf,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
  transitionClassEvent,
  transitionOccurrenceCompletion,
  transitionTrial,
  SLOT_RESCHEDULABLE_FROM,
} from "@/lib/booking/transitions";
import { declineOpenReschedules } from "@/lib/booking/reschedule-decline";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
import prisma, {
  type Tx,
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import {
  assertRemediationCounts,
  MAINTENANCE_REMEDIATION_CAPACITY,
} from "@/lib/maintenance-remediation-capacity";

type NotificationPayload = {
  userIds: string[];
  data: Parameters<typeof notifyAppointmentCancelled>[1];
};

function buildCancellationNotification(params: {
  appointmentId: string;
  appointmentType: string;
  /** ADR 23 — routes the notification to the dashboard owning the session. */
  organizationId: string | null;
  consultantUser: { id: string; name: string | null } | null | undefined;
  participantIds: string[];
  planTitle: string;
  dateTime: string;
  consulteeName?: string;
}): NotificationPayload | null {
  const userIds = [...params.participantIds];
  if (
    params.consultantUser?.id &&
    !userIds.includes(params.consultantUser.id)
  ) {
    userIds.push(params.consultantUser.id);
  }
  if (userIds.length === 0) return null;
  return {
    userIds,
    data: {
      appointmentId: params.appointmentId,
      appointmentType: params.appointmentType,
      consultantName: params.consultantUser?.name || "Consultant",
      consulteeName: params.consulteeName || "Participants",
      planTitle: params.planTitle,
      dateTime: params.dateTime,
      ...notificationScope(params.organizationId),
      dashboardUrl: notificationHref(params.organizationId, "appointments"),
      reason: "Scheduled platform maintenance",
      cancelledBy: "system",
    },
  };
}

/** The slot graph the freeze works from — one query, typed once for the helpers. */
function findAffectedSlots(tx: Tx, appointmentId: string) {
  // Read cap+1 rows so oversized bookings fail before any cancellation.
  return tx.appointmentOccurrence.findMany({
    where: {
      isTentative: false,
      deletedAt: null,
      appointmentId,
    },
    take: MAINTENANCE_REMEDIATION_CAPACITY.occurrences + 1,
    include: {
      appointment: {
        include: {
          // #1554 — the roster is the appointment's live participants.
          participants: {
            where: liveParticipant(),
            take: MAINTENANCE_REMEDIATION_CAPACITY.participants + 1,
            select: { userId: true },
          },
          consultation: {
            include: {
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
            },
          },
          subscription: {
            include: {
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
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
          trial: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                },
              },
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
              consulteeProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          // #1162 — UNFILTERED by status: the old SUCCEEDED-only include made
          // an appointment whose only payment was PENDING look payment-free,
          // and the old delete guard then cascade-destroyed the Payment row.
          // Nothing is deleted any more; SUCCEEDED payments refund post-tx,
          // PENDING ones settle via the capture-after-terminal webhook path.
          // `deletedAt` rides along so the refund collector can skip retired
          // rows (#781 §B) without a second query.
          payment: {
            take: MAINTENANCE_REMEDIATION_CAPACITY.payments + 1,
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentIntent: true,
              paymentGateway: true,
              paymentStatus: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
}

type AffectedSlot = Awaited<ReturnType<typeof findAffectedSlots>>[number];
type FreezeAppointment = AffectedSlot["appointment"];
type PendingRefundPayment = FreezeAppointment["payment"][number];

/** Everything one appointment's freeze step needs, resolved once per appointment. */
type FreezeContext = {
  appointment: FreezeAppointment;
  slots: AffectedSlot[];
  earliestSlot: AffectedSlot;
};

/**
 * Post-commit work a freeze transaction produced. It accumulates LOCALLY
 * inside the transaction callback and is merged into the run totals only after
 * the commit — a rollback after a push must not leave a refund queued for a
 * booking that is still active.
 */
type FreezeEffects = {
  notifications: NotificationPayload[];
  /** Refunds stamped owed in the freeze commit, driven after it. */
  refunds: RefundOwedMarker[];
  trialsToTombstone: string[];
};

/** `null` means the row was already terminal — the whole appointment skips. */
type FreezeStepResult = FreezeEffects | null;

function noEffects(): FreezeEffects {
  return {
    notifications: [],
    refunds: [],
    trialsToTombstone: [],
  };
}

function withNotification(notif: NotificationPayload | null): FreezeEffects {
  const effects = noEffects();
  if (notif) effects.notifications.push(notif);
  return effects;
}

function mergeEffects(into: FreezeEffects, from: FreezeEffects): void {
  into.notifications.push(...from.notifications);
  into.refunds.push(...from.refunds);
  into.trialsToTombstone.push(...from.trialsToTombstone);
}

/** A CAS transition that lost its race is a skip, never an error. */
/** The history rows' reason for every move a freeze makes (#1846). */
const MAINTENANCE_REASON = "scheduled platform maintenance";

function skipOnIllegalTransition(err: unknown): FreezeStepResult {
  if (err instanceof IllegalTransitionError) return null;
  throw err;
}

// Cancel consultation if applicable — CAS-guarded (#1162): a COMPLETED or
// already-CANCELLED booking must not resurrect.
async function freezeConsultation(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const consultation = ctx.appointment.consultation;
  if (!consultation) return noEffects();

  try {
    await transitionConsultationRequest(tx, {
      where: { id: consultation.id },
      to: "CANCELLED",
      data: {
        cancellationReason: "TECHNICAL_ISSUE",
        cancellationNotes: "Cancelled due to scheduled platform maintenance",
        cancelledAt: new Date(),
      },
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "CONSULTATION",
      consultantUser: consultation.consultationPlan?.consultantProfile?.user,
      participantIds: consultation.requestedBy?.user?.id
        ? [consultation.requestedBy.user.id]
        : [],
      planTitle: consultation.consultationPlan?.title || "Consultation",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: consultation.requestedBy?.user?.name || "User",
    }),
  );
}

// Cancel subscription appointment if applicable — CAS-guarded.
async function freezeSubscription(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const subscription = ctx.appointment.subscription;
  if (!subscription) return noEffects();

  try {
    await transitionSubscriptionRequest(tx, {
      where: { id: subscription.id },
      to: "CANCELLED",
      data: {
        cancellationReason: "TECHNICAL_ISSUE",
        cancellationNotes: "Cancelled due to scheduled platform maintenance",
        cancelledAt: new Date(),
      },
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  const effects = withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "SUBSCRIPTION",
      consultantUser: subscription.subscriptionPlan?.consultantProfile?.user,
      participantIds: subscription.requestedBy?.user?.id
        ? [subscription.requestedBy.user.id]
        : [],
      planTitle: subscription.subscriptionPlan?.title || "Subscription",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: subscription.requestedBy?.user?.name || "User",
    }),
  );
  return effects;
}

/** Every seat holder on the frozen bookings — group events notify all attendees. */
function attendeeIds(slots: AffectedSlot[]): string[] {
  return Array.from(
    new Set(
      slots.flatMap((s) => s.appointment.participants.map((p) => p.userId)),
    ),
  );
}

// Cancel webinar if applicable
async function freezeWebinar(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const webinar = ctx.appointment.webinar;
  if (!webinar) return noEffects();

  try {
    await transitionWebinarEvent(tx, {
      where: { id: webinar.id },
      to: "CANCELLED",
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "WEBINAR",
      consultantUser: webinar.webinarPlan?.consultantProfile?.user,
      participantIds: attendeeIds(ctx.slots),
      planTitle: webinar.webinarPlan?.title || "Webinar",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
    }),
  );
}

// Cancel class if applicable
async function freezeClass(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const classEvent = ctx.appointment.class;
  if (!classEvent) return noEffects();

  try {
    await transitionClassEvent(tx, {
      where: { id: classEvent.id },
      to: "CANCELLED",
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "CLASS",
      consultantUser: classEvent.classPlan?.consultantProfile?.user,
      participantIds: attendeeIds(ctx.slots),
      planTitle: classEvent.classPlan?.title || "Class",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
    }),
  );
}

// Cancel trial session if applicable
async function freezeTrial(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const trial = ctx.appointment.trial;
  if (!trial) return noEffects();

  // #1846 SM-B13 — through the helper, so the move writes its history row;
  // a zero-row CAS means already terminal — skip, never resurrect.
  try {
    await transitionTrial(tx, {
      reason: MAINTENANCE_REASON,
      where: { id: trial.id },
      to: "CANCELLED",
      data: { pendingPaymentUrl: null },
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  const effects = withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "TRIAL",
      consultantUser: trial.consultantProfile?.user,
      participantIds: trial.consulteeProfile?.user?.id
        ? [trial.consulteeProfile.user.id]
        : [],
      planTitle: trial.subscriptionPlan?.title || "Trial Session",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: trial.consulteeProfile?.user?.name || "User",
    }),
  );
  // #1074 — tombstone via the trials-domain helper AFTER the tx; it owns the
  // appointment/slot shape for trials.
  effects.trialsToTombstone.push(ctx.appointment.id);
  return effects;
}

/**
 * Each appointment type gets its turn inside the transaction. A type that does
 * not apply contributes nothing; a row that is already terminal aborts the
 * whole appointment.
 */
const FREEZE_STEPS = [
  freezeConsultation,
  freezeSubscription,
  freezeWebinar,
  freezeClass,
  freezeTrial,
];

/**
 * The full refund each SUCCEEDED payment of a frozen booking is owed.
 *
 * Retired (soft-deleted) rows are left behind: the front door
 * refuses them, so queueing one only mints a false refund failure.
 */
function refundsOwed(
  appointmentId: string,
  payments: FreezePayment[],
): RefundOwedMarker[] {
  return payments
    .filter((p) => p.paymentStatus === "SUCCEEDED" && p.deletedAt === null)
    .map((p) => ({
      paymentId: p.id,
      amountPaise: null,
      key: `freeze:${appointmentId}:${p.id}`,
      reason: STAFF_CANCEL_REFUND_REASON.MAINTENANCE,
    }));
}

type FreezePayment = Pick<
  PendingRefundPayment,
  "id" | "paymentStatus" | "deletedAt"
>;

/**
 * Every refund the freeze owes commits with it, in one statement; a payment
 * another door's refund already holds is recorded and held for a hand top-up,
 * and only the markers the freeze owns are queued.
 */
export async function stampFreezeRefunds(
  tx: Tx,
  appointmentId: string,
  payments: FreezePayment[],
): Promise<RefundOwedMarker[]> {
  const owed = refundsOwed(appointmentId, payments);
  if ((await stampRefundsOwed(tx, owed)) === owed.length) return owed;
  const held = new Set((await heldInsteadOf(tx, owed)).map((h) => h.paymentId));
  return owed.filter((m) => !held.has(m.paymentId));
}

/**
 * #1162 — "Nothing is deleted" (docs/booking/08). Slots soft-cancel exactly
 * like the interactive cancel route; trials are tombstoned by their own helper
 * post-tx instead.
 */
async function closeFrozenSlots(tx: Tx, ctx: FreezeContext): Promise<void> {
  if (ctx.appointment.trial) return;
  // #1846 SM-B13 — through the helper, so each slot writes its history row.
  // The tombstone is half of the soft-cancel, as on every other cancel path:
  // since #1694 the overlap constraint exempts only `deletedAt IS NOT NULL`, so
  // a CANCELLED row without it kept blocking the consultant's time.
  await transitionOccurrenceCompletion(tx, {
    reason: MAINTENANCE_REASON,
    where: { id: { in: ctx.slots.map((s) => s.id) } },
    to: "CANCELLED",
    data: { deletedAt: new Date() },
    fromIn: SLOT_RESCHEDULABLE_FROM,
    allowZero: true,
  });
}

/** All booking effects use the graph read by the cancellation transaction. */
async function freezeOneAppointment(tx: Tx, ctx: FreezeContext) {
  const effects = noEffects();

  for (const step of FREEZE_STEPS) {
    const result = await step(tx, ctx);
    if (!result) return { skipped: true } as const;
    mergeEffects(effects, result);
  }

  for (const notice of effects.notifications)
    assertRemediationCounts(ctx.appointment.id, {
      participants: ctx.appointment.participants.length,
      occurrences: ctx.slots.length,
      payments: ctx.appointment.payment.length,
      recipients: new Set(notice.userIds).size,
    });
  effects.refunds.push(
    ...(await stampFreezeRefunds(
      tx,
      ctx.appointment.id,
      ctx.appointment.payment,
    )),
  );

  await closeFrozenSlots(tx, ctx);
  for (const trialId of effects.trialsToTombstone)
    await softCancelTrialAppointmentInTx(tx, trialId);
  for (const { userIds, data } of effects.notifications) {
    // A maintenance freeze is staff ending the booking: every party is told whatever their switches say.
    await notifyAppointmentCancelled(userIds, data, {
      tx,
      deferAttempt: true,
      dedupeKey: `maintenance-cancel:${ctx.appointment.id}`,
      required: { kind: "CANCELLED_BY_STAFF", recipients: userIds },
    });
    await stageAppointmentCancelledEmail(tx, {
      appointmentId: ctx.appointment.id,
      userIds,
      requiredFor: userIds,
      startsAt: data.dateTime ? new Date(data.dateTime) : undefined,
      cancelledBy: "Familiarise",
      reason: data.reason,
      dashboardUrl: data.dashboardUrl ?? notificationHref(null, "appointments"),
    });
  }
  // Leaving a proposal open reserves openForAppointmentId forever and lets
  // the expiry sweep act on a cancelled booking. #1846 — the shared helper
  // declines through the CAS and writes the history row the raw update skipped.
  await declineOpenReschedules(tx, ctx.appointment.id, {
    reason: MAINTENANCE_REASON,
  });

  return { skipped: false, ...effects } as const;
}

/** Callers group by appointment, so the list always holds at least one slot. */
function earliestSlotOf(slots: AffectedSlot[]): AffectedSlot {
  let earliest = slots[0];
  for (const slot of slots) {
    if (slot.startsAt < earliest.startsAt) earliest = slot;
  }
  return earliest;
}

export async function freezeAppointments(
  maintenanceStart: Date,
  maintenanceEnd: Date,
  appointmentId: string,
) {
  const outcome = await prisma.$transaction(
    async (tx) => {
      const overlapping = await tx.appointmentOccurrence.findFirst({
        where: {
          appointmentId,
          appointment: { deletedAt: null },
          isTentative: false,
          deletedAt: null,
          completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
          startsAt: { lt: maintenanceEnd },
          endsAt: { gt: maintenanceStart },
        },
        select: { id: true },
      });
      if (!overlapping) return { skipped: true } as const;
      const slots = await findAffectedSlots(tx, appointmentId);
      if (!slots.length) return null;
      const appointment = slots[0].appointment;
      assertRemediationCounts(appointmentId, {
        participants: appointment.participants.length,
        occurrences: slots.length,
        payments: appointment.payment.length,
      });
      return freezeOneAppointment(tx, {
        appointment,
        slots,
        earliestSlot: earliestSlotOf(slots),
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
  const effects = outcome && !outcome.skipped ? outcome : null;
  const result = {
    cancelled: effects ? 1 : 0,
    skippedAlreadyTerminal: outcome?.skipped ? 1 : 0,
    freezeErrors: 0,
    notified:
      effects?.notifications.reduce(
        (count, notice) => count + notice.userIds.length,
        0,
      ) ?? 0,
    refundsQueued: effects?.refunds.length ?? 0,
  };
  console.log(
    JSON.stringify({
      event: "maintenance_appointments_frozen",
      ...result,
      windowStart: maintenanceStart.toISOString(),
      windowEnd: maintenanceEnd.toISOString(),
      timestamp: new Date().toISOString(),
    }),
  );
  return result;
}
