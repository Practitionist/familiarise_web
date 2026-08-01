/**
 * Trial cancellation — soft-cancel + refund (#1009).
 *
 * Both cancel paths used to hard-delete the trial's appointment to free the
 * slot. `Payment.appointment` is `onDelete: Cascade`, so once paid trials
 * shipped (#1046) that delete destroyed the payment row with it: no refund, no
 * ledger entry, nothing left to reconcile against the gateway.
 *
 * The delete was never what freed the slot. `buildOccupiedAppointmentFilter`
 * counts a trial as occupying only while SCHEDULED or AWAITING_PAYMENT, so the
 * status transition alone releases it — which is exactly what the hourly expiry
 * job (`scripts/trials/expire-unpaid-trials.ts`) has always relied on. This
 * module makes the interactive paths behave like that job, and adds the refund
 * the paid path needs.
 */

import * as Sentry from "@sentry/nextjs";
import { PaymentStatus, SlotCompletionStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "@/lib/payments/operations/cancellation-policy";
import { refundPayment } from "@/lib/payments/operations/refund";

export type TrialRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /** Set when the gateway leg failed; the cancellation still stands. */
  failed?: boolean;
};

/**
 * Retire the appointment behind a cancelled or rejected trial.
 *
 * Soft-delete rather than delete: the tombstone (`Appointment.deletedAt`,
 * mirrored on the slots) is the sanctioned removal for anything money rows hang
 * off, and it keeps the trial ↔ appointment link readable for support and
 * reconciliation. Callers must have already moved the trial out of
 * SCHEDULED/AWAITING_PAYMENT, or the slot stays occupied.
 */
export async function softCancelTrialAppointment(
  appointmentId: string,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.slotOfAppointment.updateMany({
      where: { appointmentId, deletedAt: null },
      data: {
        completionStatus: SlotCompletionStatus.CANCELLED,
        deletedAt: now,
      },
    });
    await tx.appointment.updateMany({
      where: { id: appointmentId, deletedAt: null },
      data: { deletedAt: now },
    });
  });
}

/**
 * Refund a paid trial on cancellation, using the same booking-time policy
 * snapshot the appointment cancel route applies.
 *
 * Returns null when there is nothing to refund — a free trial, an unpaid
 * AWAITING_PAYMENT trial that lapsed, or a payment that never captured.
 *
 * Deliberately never throws: the cancellation has already committed by the time
 * this runs, and a gateway failure must not roll it back. A failed refund is
 * reported to Sentry and surfaced to the caller as `failed`, matching how
 * `app/api/appointments/[appointmentId]/cancel/route.ts` handles the same case.
 */
export async function refundCancelledTrial(args: {
  trialId: string;
  appointmentId: string | null;
  paymentId: string | null;
  initiatedByUserId: string;
  isConsultantInitiated: boolean;
}): Promise<TrialRefundOutcome | null> {
  const { trialId, appointmentId, paymentId, initiatedByUserId } = args;

  // TrialSession.paymentId is ledger truth once a paid trial settles, but the
  // webhook writes it after capture — fall back to the appointment's payment so
  // a cancellation racing that write still refunds.
  const payment = await prisma.payment.findFirst({
    where: {
      deletedAt: null,
      paymentStatus: PaymentStatus.SUCCEEDED,
      amount: { gt: 0 },
      ...(paymentId
        ? { id: paymentId }
        : appointmentId
          ? { appointmentId }
          : { id: "__none__" }),
    },
    select: { id: true, amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });

  if (!payment) return null;

  const appointment = appointmentId
    ? await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          cancellationPolicySnapshot: true,
          slotsOfAppointment: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true },
          },
        },
      })
    : null;

  const startsAt = appointment?.slotsOfAppointment[0]?.startsAt;
  const hoursUntilStart = startsAt
    ? (startsAt.getTime() - Date.now()) / 3_600_000
    : -1;

  const refundPct = computeRefundPct(
    parsePolicySnapshot(appointment?.cancellationPolicySnapshot),
    hoursUntilStart,
    args.isConsultantInitiated,
  );
  // Clamp to the remaining balance, as the cancel and seat-refund paths do. A
  // percentage of the gross overshoots a payment that has already given some
  // back, `refundPayment` rejects the whole request, and the catch below turns
  // that into "refunded 0" — the buyer loses the remainder they were owed.
  const amountPaise = Math.min(
    Math.floor((Number(payment.amount) * refundPct) / 100),
    refundableBalancePaise(Number(payment.amount), payment),
  );

  if (amountPaise <= 0) return { refundPct, amountRefundedPaise: 0 };

  try {
    const result = await refundPayment({
      paymentId: payment.id,
      amountPaise,
      reason: `trial cancellation (${refundPct}% per booking-time policy, ${
        args.isConsultantInitiated ? "consultant" : "consultee"
      }-initiated)`,
      initiatedByUserId,
    });
    return {
      refundPct,
      amountRefundedPaise: result.amountRefundedPaise,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "trials" },
        extra: { trialId, paymentId: payment.id },
      },
    );
    console.error(`[Trials] refund failed for payment ${payment.id}:`, error);
    return { refundPct, amountRefundedPaise: 0, failed: true };
  }
}
