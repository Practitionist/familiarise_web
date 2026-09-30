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
 *
 * #1846 SM-B14 — each engagement's writes run under its appointment lock, the
 * atom the cancel, reschedule and withdraw routes take, so a ban cannot
 * interleave with a consultee's cancel or a consultant's accept. A held lock
 * fails that one engagement into `failures`, and a re-run picks it up.
 */
import * as Sentry from "@sentry/nextjs";
import type { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  liveParticipant,
  releaseParticipant,
} from "@/lib/booking/participants";
import { collaboratorUserIdsForEvent } from "@/lib/collaborators/recipients";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { EMAIL_BUDGET_MS, sendAppointmentCancelledEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { isModelledRefundRefusal } from "@/lib/payments/operations/refund";
import { reportSentryError } from "@/lib/observability/report";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import {
  classSeriesLedgers,
  refundWholeEventPayments,
} from "@/lib/payments/operations/event-refunds";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  SLOT_RESCHEDULABLE_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { declineOpenReschedules } from "@/lib/booking/reschedule-decline";
import { withAppointmentLock } from "@/utils/appointmentlock";

export interface BulkCancelSummary {
  engagementsCancelled: number;
  attendeeRemovals: number;
  refundsIssued: number;
  refundedPaise: number;
  failures: Array<{ kind: string; id: string; error: string }>;
  /**
   * Classes whose seats were refunded IN FULL because the per-seat pro-rata
   * series ledger could not be read — as opposed to the seats that were netted
   * to what the series did not deliver.
   *
   * Separate from `failures` on purpose. A `refundsIssued` / `refundedPaise`
   * total cannot express which of the two produced it: a class of ten sessions
   * with eight taught nets two, and the same class with an unreadable ledger
   * returns ten, and the two numbers are the same shape. An operator reading
   * only the totals cannot tell a correct pro-rata refund from a deliberate
   * over-refund, which is the whole reason this list exists.
   */
  refundedInFullOnUnreadableLedger: Array<{
    classId: string;
    reason: string;
  }>;
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

type FutureSlotFilter = {
  completionStatus: "SCHEDULED";
  startsAt: { gt: Date };
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const captureModerationError = (error: unknown) =>
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "moderation" } },
  );

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
    refundedInFullOnUnreadableLedger: [],
    remaining: [],
  };

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { consulteeProfileId: true, consultantProfileId: true },
  });
  if (!target) return summary;

  const futureSlot: FutureSlotFilter = {
    completionStatus: "SCHEDULED",
    startsAt: { gt: new Date() },
  };

  const work: WorkItem[] = [];
  if (target.consulteeProfileId) {
    work.push(
      ...(await collectConsulteeWork(
        target.consulteeProfileId,
        targetUserId,
        futureSlot,
      )),
    );
  }
  if (target.consultantProfileId) {
    work.push(
      ...(await collectConsultantWork(target.consultantProfileId, futureSlot)),
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
    await runWorkItem(work[i], targetUserId, {
      initiatedByUserId,
      notes,
      summary,
    });
  }

  return summary;
}

// Engagements where the target is the buyer (consultee): exclusive
// consultations/subscriptions they own, plus group events they merely attend.
async function collectConsulteeWork(
  consulteeProfileId: string,
  targetUserId: string,
  futureSlot: FutureSlotFilter,
): Promise<WorkItem[]> {
  const [consultations, subscriptions, attendedSlots] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        requestedById: consulteeProfileId,
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.subscription.findMany({
      where: {
        requestedById: consulteeProfileId,
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
    // Group events the target merely attends — remove + refund just them.
    prisma.appointmentOccurrence.findMany({
      where: {
        ...futureSlot,
        appointment: {
          OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
          participants: { some: liveParticipant(targetUserId) },
        },
      },
      select: {
        appointment: { select: { webinarId: true, classId: true } },
      },
    }),
  ]);

  const work: WorkItem[] = [
    ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
    ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
  ];
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
  return work;
}

// Engagements the target hosts (consultant): exclusive engagements plus whole
// group events they run — every attendee is refunded when these cancel.
async function collectConsultantWork(
  consultantProfileId: string,
  futureSlot: FutureSlotFilter,
): Promise<WorkItem[]> {
  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        consultationPlan: { consultantProfileId },
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.subscription.findMany({
      where: {
        subscriptionPlan: { consultantProfileId },
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.webinar.findMany({
      where: {
        webinarPlan: { consultantProfileId },
        status: { in: EVENT_ALLOWED_FROM.CANCELLED },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.class.findMany({
      where: {
        classPlan: { consultantProfileId },
        status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
        appointment: { occurrences: { some: futureSlot } },
      },
      select: { id: true },
    }),
  ]);
  return [
    ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
    ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
    ...webinars.map((w) => ({ kind: "webinar-event" as const, id: w.id })),
    ...classes.map((c) => ({ kind: "class-event" as const, id: c.id })),
  ];
}

// Dispatch a single work item; every failure is recorded and swallowed so the
// budgeted loop continues to the next engagement.
async function runWorkItem(
  item: WorkItem,
  targetUserId: string,
  ctx: {
    initiatedByUserId: string;
    notes?: string;
    summary: BulkCancelSummary;
  },
): Promise<void> {
  const { initiatedByUserId, notes, summary } = ctx;
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
    summary.failures.push({
      kind: item.kind,
      id: item.id,
      error: errMsg(error),
    });
    captureModerationError(error);
  }
}

interface NormalizedEngagement {
  planTitle?: string;
  consultantUser?: { id: string; name: string | null } | null;
  consulteeUser?: { id: string; name: string | null } | null;
  appointments: Array<{
    id: string;
    appointmentType: string;
    organizationId: string | null;
    // amount is number at runtime — the extended client converts BigInt on read
    payment: Array<{
      id: string;
      amount: number;
      paymentStatus: string;
      deletedAt: Date | null;
    }>;
  }>;
}

async function loadExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
): Promise<NormalizedEngagement | null> {
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
      // ADR 23 — attribute the cancellation notification to the dashboard that
      // owns the session rather than defaulting everyone to their personal one.
      organizationId: true,
      payment: {
        select: {
          id: true,
          amount: true,
          paymentStatus: true,
          // #781 §B — the refund front door refuses retired rows; carry the
          // tombstone so the caller can skip them instead of failing on them.
          deletedAt: true,
        },
      },
    },
  } as const;

  if (kind === "consultation") {
    const row = await prisma.consultation.findUnique({
      where: { id: engagementId },
      select: {
        consultationPlan: planSelect,
        requestedBy: requestedBySelect,
        appointment: appointmentSelect,
      },
    });
    if (!row) return null;
    return {
      planTitle: row.consultationPlan?.title,
      consultantUser: row.consultationPlan?.consultantProfile?.user,
      consulteeUser: row.requestedBy?.user,
      appointments: row.appointment ? [row.appointment] : [],
    };
  }

  const row = await prisma.subscription.findUnique({
    where: { id: engagementId },
    select: {
      subscriptionPlan: planSelect,
      requestedBy: requestedBySelect,
      appointment: appointmentSelect,
    },
  });
  if (!row) return null;
  return {
    planTitle: row.subscriptionPlan?.title,
    consultantUser: row.subscriptionPlan?.consultantProfile?.user,
    consulteeUser: row.requestedBy?.user,
    appointments: row.appointment ? [row.appointment] : [],
  };
}

/**
 * Guarded status move plus the slot soft-cancel that rides with it. Returns 0
 * when the CAS found nothing to move — the engagement was already terminal.
 */
async function casCancelExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
  appointmentId: string | null,
  ctx: { initiatedByUserId: string; notes?: string },
): Promise<number> {
  const now = new Date();
  const cancellationData = {
    cancellationReason: "MODERATION" as const,
    cancellationNotes: ctx.notes ?? null,
    cancelledAt: now,
    cancelledBy: ctx.initiatedByUserId,
  };
  const audit = {
    actorUserId: ctx.initiatedByUserId,
    reason: MODERATION_REASON,
  };

  const cancel = () =>
    prisma.$transaction(async (tx) => {
      // #1583 A-P0-05 — through the helpers so the history row rides along;
      // the zero-row throw is the old `count === 0` (already terminal).
      try {
        if (kind === "consultation") {
          await transitionConsultationRequest(tx, {
            ...audit,
            where: { id: engagementId },
            to: "CANCELLED",
            fromIn: [...CANCELLABLE_FROM],
            data: cancellationData,
          });
        } else {
          await transitionSubscriptionRequest(tx, {
            ...audit,
            where: { id: engagementId },
            to: "CANCELLED",
            fromIn: [...CANCELLABLE_FROM],
            data: cancellationData,
          });
        }
      } catch (err) {
        if (err instanceof IllegalTransitionError) return 0;
        throw err;
      }
      await releaseEngagementOccurrences(
        tx,
        kind === "consultation"
          ? { appointment: { consultationId: engagementId } }
          : { appointment: { subscriptionId: engagementId } },
        now,
        audit,
      );
      // #1846 SM-B14 — an open proposal on a cancelled booking would keep its
      // reservation and let the expiry sweep act on a dead booking.
      if (appointmentId) {
        await declineOpenReschedules(tx, appointmentId, audit);
      }
      return 1;
    });
  // A request that never got a wrapper has no atom to lock; its CAS decides.
  return appointmentId ? withAppointmentLock(appointmentId, cancel) : cancel();
}

const MODERATION_REASON = "moderation";

/**
 * Tombstone the engagement's live slots. Since #1694 the overlap constraint
 * exempts only `deletedAt IS NOT NULL`, so a CANCELLED row without the
 * tombstone stayed armed and phantom-blocked the consultant's time.
 */
async function releaseEngagementOccurrences(
  tx: Pick<Tx, "appointmentOccurrence" | "bookingStatusHistory">,
  scope: Prisma.AppointmentOccurrenceWhereInput,
  now: Date,
  audit: { actorUserId: string; reason: string },
): Promise<void> {
  await transitionOccurrenceCompletion(tx, {
    ...audit,
    where: { ...scope, deletedAt: null },
    to: "CANCELLED",
    fromIn: [...SLOT_RESCHEDULABLE_FROM],
    data: { deletedAt: now },
    allowZero: true,
  });
  // Rows the pre-#1583 raw release already left CANCELLED are still armed
  // without a tombstone; no status moves here, so no helper is involved.
  await tx.appointmentOccurrence.updateMany({
    where: { ...scope, completionStatus: "CANCELLED", deletedAt: null },
    data: { deletedAt: now },
  });
}

/**
 * Payments this cancellation owes money back on.
 *
 * #1161 — free_ (credit-funded) payments are refundable now: their "refund" is
 * the credit restoration the front door performs, so a zero-amount row can no
 * longer shadow a refundable gateway payment.
 * #781 §B — retired (soft-deleted) rows are NOT: refundBookingPayment refuses
 * them, so queueing one only mints a false failure and a Sentry event.
 */
function refundableEngagementPayments(engagement: NormalizedEngagement) {
  return engagement.appointments.flatMap((appt) =>
    appt.payment.filter(
      (p) => p.paymentStatus === "SUCCEEDED" && p.deletedAt === null,
    ),
  );
}

async function notifyExclusiveCancellation(
  kind: "consultation" | "subscription",
  engagement: NormalizedEngagement,
): Promise<void> {
  const userIds = [
    engagement.consultantUser?.id,
    engagement.consulteeUser?.id,
  ].filter((id): id is string => !!id);
  if (userIds.length === 0) return;

  const engagementOrgId = engagement.appointments[0]?.organizationId ?? null;
  await notifyAppointmentCancelled(userIds, {
    ...notificationScope(engagementOrgId),
    appointmentType:
      engagement.appointments[0]?.appointmentType ?? kind.toUpperCase(),
    consultantName: engagement.consultantUser?.name || "Consultant",
    consulteeName: engagement.consulteeUser?.name || "Consultee",
    // #536 — never show the customer a placeholder as the session's name.
    planTitle: planTitleOrSessionLabel(
      engagement.planTitle,
      engagement.appointments[0]?.appointmentType ?? kind,
    ),
    dashboardUrl: notificationHref(engagementOrgId, "appointments"),
    reason: "MODERATION",
    cancelledBy: "system",
  });
  // #1653 — the email twin; the sender never throws.
  const engagementAppointmentId = engagement.appointments[0]?.id;
  if (engagementAppointmentId) {
    await sendAppointmentCancelledEmail(
      {
        appointmentId: engagementAppointmentId,
        userIds,
        cancelledBy: "Familiarise",
        reason: "Account moderation",
        dashboardUrl: notificationHref(engagementOrgId, "appointments"),
      },
      EMAIL_BUDGET_MS.JOB,
    );
  }
}

async function cancelExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
  ctx: {
    initiatedByUserId: string;
    notes?: string;
    summary: BulkCancelSummary;
  },
) {
  const engagement = await loadExclusiveEngagement(kind, engagementId);
  if (!engagement) return;

  const moved = await casCancelExclusiveEngagement(
    kind,
    engagementId,
    engagement.appointments[0]?.id ?? null,
    ctx,
  );
  if (moved === 0) return; // lost the CAS — already terminal, no refund

  ctx.summary.engagementsCancelled += 1;

  for (const p of refundableEngagementPayments(engagement)) {
    await issueFullRefund(p.id, ctx.initiatedByUserId, ctx.summary);
  }

  await notifyExclusiveCancellation(kind, engagement);
}

/**
 * The event's guarded status move plus the slot release, under the event
 * wrapper's appointment lock (#1846 SM-B14). Returns 0 when the CAS found
 * nothing to move — the event was already terminal.
 */
async function casCancelGroupEvent(
  isWebinar: boolean,
  eventId: string,
  initiatedByUserId: string,
): Promise<number> {
  const audit = { actorUserId: initiatedByUserId, reason: MODERATION_REASON };
  const eventScope = isWebinar ? { webinarId: eventId } : { classId: eventId };
  const eventWrapper = await prisma.appointment.findFirst({
    where: eventScope,
    select: { id: true },
  });
  const cancel = () =>
    prisma.$transaction(async (tx) => {
      // #1583 A-P0-05 — same shape as the exclusive arm above.
      try {
        if (isWebinar) {
          await transitionWebinarEvent(tx, {
            ...audit,
            where: { id: eventId },
            to: "CANCELLED",
            fromIn: EVENT_ALLOWED_FROM.CANCELLED,
          });
        } else {
          await transitionClassEvent(tx, {
            ...audit,
            where: { id: eventId },
            to: "CANCELLED",
            fromIn: CLASS_EVENT_ALLOWED_FROM.CANCELLED,
          });
        }
      } catch (err) {
        if (err instanceof IllegalTransitionError) return 0;
        throw err;
      }
      await releaseEngagementOccurrences(
        tx,
        { appointment: eventScope },
        new Date(),
        audit,
      );
      return 1;
    });
  return eventWrapper ? withAppointmentLock(eventWrapper.id, cancel) : cancel();
}

/**
 * #1780 D-5 — the class ledger for the refund, or `null` when it could not be
 * read. `null` is the whole-balance answer every door used before #1780, so a
 * transient read failure degrades to the old behaviour instead of losing the
 * refunds.
 *
 * THE FULL REFUND IS A DELIBERATE CHOICE, NOT THE CORRECT ARITHMETIC. Netting a
 * seat to `amount − unit × deliveredHeld` is the right answer; returning the
 * whole balance because the read failed is the second-best one, and it costs the
 * consultant the share for every session actually taught. It is taken anyway
 * because the alternatives are worse: this runs once, inside a staff-triggered
 * moderation action, so deferring the event loses the cancellation AND the
 * refunds, and refunding nothing strands an innocent attendee's money on a
 * booking a moderator has already ended. A ban that under-refunds is a support
 * queue; a ban that over-refunds is a ledger line somebody reconciles.
 *
 * What is NOT permitted is doing that silently, which is what this function
 * exists to prevent. Three signals, deliberately distinct from one another and
 * from the per-seat refund failures:
 *
 *   1. `summary.refundedInFullOnUnreadableLedger` — the summary names the class
 *      and says the netting was skipped, so `refundsIssued` / `refundedPaise`
 *      cannot be read as a pro-rata result.
 *   2. A `failures` row under its own `kind`, so it is never counted as one
 *      failed seat among many.
 *   3. A durable `SystemEvent`. A `summary.failures` row rides the response of
 *      whoever pressed the button and a Sentry event evaporates; neither is
 *      findable when the reconciliation question arrives a week later, which is
 *      the only moment the question is asked.
 *
 * CORRECTION PATH: the admin whole-event refund door
 * (app/api/admin/refunds/route.ts) reads the ledger again and refunds a class
 * WITHOUT touching its status, so once the read works it nets the same seats to
 * the same shortfall and the operator tops up through there. No compensating
 * entry is written here — an automatic clawback would race a human reading the
 * same class.
 */
async function readClassSeriesLedgers(
  classId: string,
  ctx: { summary: BulkCancelSummary },
): Promise<ReturnType<typeof classSeriesLedgers> | null> {
  try {
    return await classSeriesLedgers(classId);
  } catch (error) {
    const reason = errMsg(error);
    ctx.summary.refundedInFullOnUnreadableLedger.push({ classId, reason });
    ctx.summary.failures.push({
      kind: "refund-ledger-unreadable",
      id: classId,
      error: `class series ledger unreadable, refunding every seat in full: ${reason}`,
    });
    await recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: `Moderation refunded a class in full because its series ledger was unreadable; a person must reconcile the pro-rata shortfall (class ${classId})`,
      err: error,
      context: {
        classId,
        reason,
        // What the caller does with this `null`, stated on the durable row: the
        // refund that follows is every seat at its FULL balance, not the
        // pro-rata net. A reader reconciling the consultant's earnings needs to
        // know which of the two they are looking at.
        fallbackRefundBasis: "full balance for every seat (pro-rata netting skipped)",
      },
    });
    captureModerationError(error);
    return null;
  }
}

async function cancelGroupEvent(
  kind: "webinar-event" | "class-event",
  eventId: string,
  ctx: { initiatedByUserId: string; summary: BulkCancelSummary },
) {
  const isWebinar = kind === "webinar-event";

  // #1780 D-5 — each class seat's ledger, read BEFORE `casCancelGroupEvent`
  // releases the sessions: `seatLedger` counts only rows with `deletedAt: null`,
  // so a read taken after the release sees an empty series and every seat looks
  // as though it was owed a full refund. A webinar still refunds every seat in
  // full, so there is no ledger to read for it.
  //
  // A failed read must not cost the ban its refunds, so it falls back to the
  // whole-balance behaviour this door always had — an over-refund on a
  // partly-delivered class, taken deliberately rather than computed, and never
  // silently: `readClassSeriesLedgers` records it three ways and names the
  // correction door. A webinar's `null` is not a failure and is not recorded as
  // one, because this helper is only reached for a class.
  const seriesLedgers = isWebinar
    ? null
    : await readClassSeriesLedgers(eventId, ctx);

  const moved = await casCancelGroupEvent(
    isWebinar,
    eventId,
    ctx.initiatedByUserId,
  );
  if (moved === 0) return;

  ctx.summary.engagementsCancelled += 1;

  // Whole-event moderation cancel refunds EVERY attendee in full via the
  // reversal engine (#776 §C): org-funded seats reverse in-ledger (CLASS_MULTI),
  // card/mock seats credit the gateway. The old per-payment refundPayment loop
  // failed org-funded seats (createRefund → UNKNOWN_GATEWAY on a synthetic id).
  //
  // These two totals are "money that moved", and for a class whose ledger read
  // they are money that moved TOO MUCH. `refundedInFullOnUnreadableLedger` is
  // what separates the two readings; the totals are deliberately not adjusted,
  // because understating them would misreport the refunds that really were issued
  // to the attendees who were owed them.
  const eventRefund = await refundWholeEventPayments(
    isWebinar ? "webinar" : "class",
    eventId,
    "moderation (100% — platform-initiated cancellation)",
    ctx.initiatedByUserId,
    { ledgers: seriesLedgers ?? undefined },
  );
  ctx.summary.refundsIssued += eventRefund.refundsIssued;
  ctx.summary.refundedPaise += eventRefund.refundedPaise;
  for (const f of eventRefund.failures) {
    ctx.summary.failures.push({
      kind: "refund",
      id: f.paymentId,
      error: f.error,
    });
  }

  // Light query for attendee notification (the helper doesn't return userIds).
  const attendees = await prisma.payment.findMany({
    where: {
      appointment: isWebinar ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: {
      userId: true,
      // Every attendee of one event shares its org-ness, so the first row
      // decides the scope for the whole batch.
      appointment: { select: { id: true, organizationId: true } },
    },
  });
  // #1580 C-P1-5 — the event's accepted collaborators lose it too.
  const collaboratorIds = await collaboratorUserIdsForEvent(
    isWebinar ? "webinar" : "class",
    eventId,
  );
  const attendeeIds = Array.from(
    new Set([...attendees.map((p) => p.userId), ...collaboratorIds]),
  );
  if (attendeeIds.length > 0) {
    // With collaborators but no paid seat there is no attendee row to read
    // the org from; the event's appointment carries it either way (#1593).
    const eventAppointment =
      attendees[0]?.appointment ??
      (await prisma.appointment.findFirst({
        where: isWebinar ? { webinarId: eventId } : { classId: eventId },
        select: { id: true, organizationId: true },
      }));
    const eventOrgId = eventAppointment?.organizationId ?? null;
    await notifyAppointmentCancelled(attendeeIds, {
      ...notificationScope(eventOrgId),
      appointmentType: isWebinar ? "WEBINAR" : "CLASS",
      consultantName: "Consultant",
      consulteeName: "Attendee",
      // #536 — the event's own title is not loaded on this path, so the
      // session label stands in rather than a placeholder.
      planTitle: planTitleOrSessionLabel(null, isWebinar ? "WEBINAR" : "CLASS"),
      dashboardUrl: notificationHref(eventOrgId, "appointments"),
      reason: "MODERATION",
      cancelledBy: "system",
    });
    // #1653 — the email twin, keyed by the event's appointment so a
    // re-run does not send twice; the sender never throws.
    if (eventAppointment) {
      await sendAppointmentCancelledEmail(
        {
          appointmentId: eventAppointment.id,
          userIds: attendeeIds,
          cancelledBy: "Familiarise",
          reason: "Account moderation",
          dashboardUrl: notificationHref(eventOrgId, "appointments"),
        },
        EMAIL_BUDGET_MS.JOB,
      );
    }
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

  // #1554 — a seat is released by status; the release matches zero rows when
  // the target is not (or no longer) on the roster, so nothing is refunded.
  const upcoming = await prisma.appointmentOccurrence.count({
    where: {
      appointment: eventFilter,
      completionStatus: "SCHEDULED",
      startsAt: { gt: new Date() },
    },
  });
  if (upcoming === 0) return;
  const eventWrapper = await prisma.appointment.findFirst({
    where: eventFilter,
    select: { id: true },
  });
  if (!eventWrapper) return;
  // #1846 SM-B14 — the seat release serialises with the event's own cancel.
  const released = await withAppointmentLock(eventWrapper.id, () =>
    releaseParticipant(prisma, {
      appointmentId: eventWrapper.id,
      userId: targetUserId,
    }),
  );
  if (released === 0) return;
  ctx.summary.attendeeRemovals += 1;

  const paid = await prisma.payment.findFirst({
    where: {
      userId: targetUserId,
      appointment: eventFilter,
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
      // #781 §B — a retired row is refused by the front door; picking one here
      // would only mint a false refund failure.
      deletedAt: null,
    },
    select: { id: true },
  });
  if (paid) {
    await issueFullRefund(paid.id, ctx.initiatedByUserId, ctx.summary);
  }
}

async function issueFullRefund(
  paymentId: string,
  initiatedByUserId: string,
  summary: BulkCancelSummary,
) {
  try {
    // #1003 — via the rail-aware front door, not refundPayment directly: an
    // org-funded seat carries a synthetic intent that died on UNKNOWN_GATEWAY,
    // so moderation silently reversed nothing for org-sponsored bookings.
    const r = await refundBookingPayment({
      paymentId,
      // amountPaise omitted → the full refundable balance
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
    // A modelled refusal (already made whole, nothing refundable) is recorded
    // on the summary for staff and reported `expected` (FAMILIARISE_WEB-3D).
    const modelled = isModelledRefundRefusal(error);
    reportSentryError(error, {
      subsystem: "moderation",
      op: "cancel-user-engagements.refund",
      expected: modelled,
      ...(modelled ? { level: "warning" as const } : {}),
    });
  }
}
