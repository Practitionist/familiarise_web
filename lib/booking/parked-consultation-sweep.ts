/**
 * The exit for a consultation parked after a reschedule whose restore could
 * not land: APPROVED (or SCHEDULED), paid, every session released and none
 * re-placed, no proposal open. If nobody places a time within 7 days of the
 * park, or by 48 h after the released session's original start (whichever is
 * first), the booking is cancelled with a full refund.
 */
import {
  AppointmentStatus,
  CancellationReason,
  OccurrenceCompletionStatus,
  PaymentStatus,
  Prisma,
  RescheduleInitiatorRole,
  RescheduleRequestStatus,
} from "@prisma/client";

import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { startDeadline } from "@/lib/cron/run-deadline";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import {
  driveRefundOwed,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { revokeEndedBookingChatAccess } from "@/lib/stream/access-revocation";
import { bookingOrgId } from "@/lib/stream-utils";
import { recordExpertStrike } from "./expert-reliability";
import { transitionParticipant } from "./participants";
import {
  attemptStagedRequestExpired,
  stageRequestEndedNotice,
  type StagedRequestExpiredNotice,
} from "./expiry-notices";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { SLOT_TRANSITION_TX_OPTIONS } from "./slot-release";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
} from "./transitions";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A park nobody resolves is ended this long after the proposal closed. */
export const PARKED_CONSULTATION_MAX_DAYS = 7;
/** ...or this long after the released session's original start, if that is sooner. */
export const PARKED_CONSULTATION_PAST_START_HOURS = 48;
/** Rows one run may cancel; the next run continues oldest first. */
const PARKED_PER_RUN = 25;

const CANCELLABLE_PARKED: AppointmentStatus[] = [
  AppointmentStatus.APPROVED,
  AppointmentStatus.SCHEDULED,
];

const PARK_ENDINGS: RescheduleRequestStatus[] = [
  RescheduleRequestStatus.DECLINED,
  RescheduleRequestStatus.EXPIRED,
];

const RELEASED_ROW = {
  completionStatus: OccurrenceCompletionStatus.RESCHEDULED,
  deletedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

export const PARKED_CONSULTATION_REASON =
  "No new time was placed after this session was moved, so the booking was cancelled.";
const PARKED_REFUND_TEXT = "Your payment is being refunded in full.";

/**
 * The aged park, read by the cohort and repeated in the cancel's CAS WHERE:
 * paid, released and never re-placed, nothing open, and past either deadline.
 */
export function agedParkedConsultationWhere(
  now: Date,
): Prisma.ConsultationWhereInput {
  const parkedBefore = new Date(
    now.getTime() - PARKED_CONSULTATION_MAX_DAYS * DAY_MS,
  );
  const startedBefore = new Date(
    now.getTime() - PARKED_CONSULTATION_PAST_START_HOURS * HOUR_MS,
  );
  return {
    status: { in: CANCELLABLE_PARKED },
    appointment: {
      payment: {
        some: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
      },
      rescheduleRequests: {
        none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
      },
      AND: [
        // No confirmed session at all: a placed, delivered or cancelled row means a human acted.
        { occurrences: { none: { isTentative: false, deletedAt: null } } },
        { occurrences: { some: RELEASED_ROW } },
        {
          OR: [
            {
              occurrences: {
                some: { ...RELEASED_ROW, startsAt: { lt: startedBefore } },
              },
            },
            {
              rescheduleRequests: {
                some: {
                  status: { in: PARK_ENDINGS },
                  restoredAt: null,
                  resolvedAt: { lt: parkedBefore },
                },
              },
            },
          ],
        },
      ],
    },
  };
}

/** The idle probe's question: is any parked consultation past its deadline? */
export async function hasAgedParkedConsultation(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  const row = await db.consultation.findFirst({
    where: agedParkedConsultationWhere(now),
    select: { id: true },
  });
  return row !== null;
}

const PARKED_SELECT = {
  id: true,
  appointment: {
    select: {
      id: true,
      organizationId: true,
      occurrences: {
        where: RELEASED_ROW,
        orderBy: { startsAt: "asc" as const },
        select: { id: true, startsAt: true },
      },
      rescheduleRequests: {
        where: { status: { in: PARK_ENDINGS }, restoredAt: null },
        orderBy: { resolvedAt: "desc" as const },
        take: 1,
        select: { initiatorRole: true },
      },
    },
  },
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
  consultationPlan: {
    select: {
      title: true,
      organizationId: true,
      consultantProfileId: true,
      consultantProfile: {
        select: { user: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.ConsultationSelect;

type ParkedRow = Prisma.ConsultationGetPayload<{
  select: typeof PARKED_SELECT;
}>;

/** Another door's partial refund already holds the payment: this cancel waits. */
class ParkedRefundHeldError extends Error {
  constructor(readonly paymentId: string) {
    super(`payment ${paymentId} already owes a partial refund`);
  }
}

const parkedRefundKey = (consultationId: string, paymentId: string) =>
  `parked-consultation:${consultationId}:${paymentId}`;

/**
 * Stamps a full-balance refund on every SUCCEEDED payment of the booking, in
 * the cancelling commit. A payment already owing the full balance is covered;
 * one owing another door's partial refund rolls the cancel back.
 */
async function stampParkedRefunds(
  tx: Tx,
  consultationId: string,
  appointmentId: string,
): Promise<RefundOwedMarker[]> {
  const payments = await tx.payment.findMany({
    where: {
      appointmentId,
      paymentStatus: PaymentStatus.SUCCEEDED,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, refundOwedKey: true, refundOwedPaise: true },
  });
  const markers: RefundOwedMarker[] = [];
  for (const p of payments) {
    if (p.refundOwedKey === null) {
      markers.push({
        paymentId: p.id,
        amountPaise: null,
        key: parkedRefundKey(consultationId, p.id),
        reason: "parked consultation never re-placed: automatic full refund",
      });
    } else if (p.refundOwedPaise !== null) {
      throw new ParkedRefundHeldError(p.id);
    }
  }
  if ((await stampRefundsOwed(tx, markers)) !== markers.length) {
    throw new ParkedRefundHeldError(markers[0]?.paymentId ?? "unknown");
  }
  return markers;
}

type CancelledParked = {
  markers: RefundOwedMarker[];
  notice: StagedRequestExpiredNotice;
};

/** One aged park, cancelled under the appointment lock in one Serializable commit. */
async function cancelOneParked(
  row: ParkedRow,
  appointmentId: string,
  now: Date,
): Promise<CancelledParked> {
  const consultantInitiated =
    row.appointment?.rescheduleRequests[0]?.initiatorRole ===
    RescheduleInitiatorRole.CONSULTANT;
  const consulteeUserId = row.requestedBy?.user?.id ?? null;
  const consultantUserId =
    row.consultationPlan?.consultantProfile?.user?.id ?? null;
  return withAppointmentLock(appointmentId, () =>
    withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await transitionConsultationRequest(tx, {
            where: { ...agedParkedConsultationWhere(now), id: row.id },
            to: AppointmentStatus.CANCELLED,
            fromIn: CANCELLABLE_PARKED,
            data: {
              cancelledAt: now,
              cancelledBy: null,
              cancellationReason: consultantInitiated
                ? CancellationReason.CONSULTANT_UNAVAILABLE
                : CancellationReason.OTHER,
              cancellationNotes: PARKED_CONSULTATION_REASON,
            },
            actorUserId: null,
            appointmentId,
            reason: PARKED_CONSULTATION_REASON,
          });
          const released = row.appointment?.occurrences ?? [];
          // Tombstoned like the cancel door's rows, so no `deletedAt: null` reader still sees them.
          await transitionOccurrenceCompletion(tx, {
            where: { appointmentId, ...RELEASED_ROW },
            to: OccurrenceCompletionStatus.CANCELLED,
            data: { deletedAt: now },
            allowZero: true,
          });
          await transitionParticipant(tx, { appointmentId }, "CANCELLED");
          const markers = await stampParkedRefunds(tx, row.id, appointmentId);
          // The expert moved the session and never placed it again: their miss.
          if (
            consultantInitiated &&
            row.consultationPlan?.consultantProfileId
          ) {
            await recordExpertStrike(tx, {
              consultantProfileId: row.consultationPlan.consultantProfileId,
              cause: "EXPERT_CANCEL",
              appointmentId,
              occurrenceIds: released.map((o) => o.id),
              organizationId: row.appointment?.organizationId ?? null,
            });
          }
          const notice = await stageRequestEndedNotice(
            tx,
            {
              appointmentId,
              organizationId: row.appointment?.organizationId ?? null,
              consulteeName: row.requestedBy?.user?.name ?? "Consultee",
              consultantName:
                row.consultationPlan?.consultantProfile?.user?.name ??
                "Consultant",
              planTitle: row.consultationPlan?.title ?? "Consultation",
              appointmentType: "CONSULTATION",
              startsAt: released[0]?.startsAt ?? null,
              reason: PARKED_CONSULTATION_REASON,
            },
            {
              recipients: [consulteeUserId, consultantUserId].flatMap((id) =>
                id ? [id] : [],
              ),
              refundText: PARKED_REFUND_TEXT,
              refundUserIds: consulteeUserId ? [consulteeUserId] : [],
            },
          );
          return { markers, notice };
        },
        {
          ...SLOT_TRANSITION_TX_OPTIONS,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      ),
    ),
  );
}

export interface ParkedConsultationSweepResult {
  cancelled: number;
  issued: number;
  failures: number;
  errors: string[];
}

/** Ends the booking's chat access after its cancel committed; a Stream failure queues its own retry. */
async function revokeParkedChat(
  row: ParkedRow,
  failures: RunFailureReporter,
): Promise<void> {
  const consulteeUserId = row.requestedBy?.user?.id;
  const consultantUserId = row.consultationPlan?.consultantProfile?.user?.id;
  if (!consulteeUserId || !consultantUserId) return;
  try {
    await revokeEndedBookingChatAccess({
      userIds: [consulteeUserId],
      dmCounterpartUserIds: [consultantUserId],
      dmOrganizationId: bookingOrgId({
        consultationPlan: row.consultationPlan,
        appointment: row.appointment,
      }),
    });
  } catch (error) {
    failures.add("parked-consultation-chat", error, { consultationId: row.id });
  }
}

/** Cancels one aged park and returns its markers; a row another writer holds returns none. */
async function settleOneParked(
  row: ParkedRow,
  now: Date,
  result: ParkedConsultationSweepResult,
  failures: RunFailureReporter,
): Promise<RefundOwedMarker[]> {
  const appointmentId = row.appointment?.id;
  if (!appointmentId) return [];
  try {
    const done = await cancelOneParked(row, appointmentId, now);
    result.cancelled += 1;
    await revokeParkedChat(row, failures);
    await attemptStagedRequestExpired(done.notice, EMAIL_BUDGET_MS.JOB);
    return done.markers;
  } catch (error) {
    // Moved since the read, or a live writer holds the booking: the next run decides.
    if (
      error instanceof IllegalTransitionError ||
      error instanceof AppointmentBusyError
    ) {
      return [];
    }
    if (error instanceof ParkedRefundHeldError) {
      result.errors.push(
        `Parked consultation ${row.id} waits: ${error.message}`,
      );
      return [];
    }
    const lockDown = error instanceof BookingLockUnavailableError;
    failures.add(
      lockDown ? "parked-consultation-lock" : "parked-consultation-cancel",
      error,
      { consultationId: row.id },
    );
    result.errors.push(`Failed to cancel parked consultation ${row.id}`);
    return [];
  }
}

/** Drives the committed markers until the run's deadline; `retry-auto-refunds` drives the rest. */
async function driveParkedRefunds(
  markers: RefundOwedMarker[],
  pastDeadline: () => boolean,
  result: ParkedConsultationSweepResult,
  failures: RunFailureReporter,
): Promise<void> {
  for (const marker of markers) {
    if (pastDeadline()) return;
    const outcome = await driveRefundOwed(marker);
    if (outcome.kind === "refunded") result.issued += 1;
    else if (outcome.kind === "failed") {
      result.failures += 1;
      failures.add("parked-consultation-refund", outcome.error, {
        paymentId: marker.paymentId,
      });
    }
  }
}

/**
 * Cancels every consultation parked past its deadline, oldest first and
 * bounded by the job's run deadline: the request CAS carries the park and money
 * predicates, the released rows close and are tombstoned, the participants are
 * cancelled, a full refund is owed in the same commit (driven after it,
 * re-driven by `retry-auto-refunds`), an expert who started the move takes a
 * strike, chat access ends, and both sides are told through the outbox.
 * Sentry hears once per run.
 */
export async function cancelAgedParkedConsultations(
  opts: { maxRows?: number; now?: Date; pastDeadline?: () => boolean } = {},
): Promise<ParkedConsultationSweepResult> {
  const now = opts.now ?? new Date();
  const pastDeadline = opts.pastDeadline ?? startDeadline();
  const failures = createRunFailureReporter("bookings");
  const result: ParkedConsultationSweepResult = {
    cancelled: 0,
    issued: 0,
    failures: 0,
    errors: [],
  };
  try {
    const rows = await prisma.consultation.findMany({
      where: agedParkedConsultationWhere(now),
      select: PARKED_SELECT,
      orderBy: { updatedAt: "asc" },
      take: Math.min(opts.maxRows ?? PARKED_PER_RUN, PARKED_PER_RUN),
    });
    const markers: RefundOwedMarker[] = [];
    for (const row of rows) {
      if (pastDeadline()) break;
      markers.push(...(await settleOneParked(row, now, result, failures)));
    }
    await driveParkedRefunds(markers, pastDeadline, result, failures);
  } catch (error) {
    failures.add("parked-consultation-read", error);
    result.errors.push(`Failed to read parked consultations: ${error}`);
  } finally {
    failures.flush();
  }
  return result;
}
