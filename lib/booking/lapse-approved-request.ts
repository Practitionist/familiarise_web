import type { Tx } from "@/lib/prisma";
import {
  AppointmentStatus,
  OccurrenceCompletionStatus,
  PaymentStatus,
} from "@prisma/client";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/**
 * #1775 — one approved-but-unpaid request lapsing, whoever asks for it: the
 * 7-day sweep (`PAYMENT_LAPSED`) or the consultant's Withdraw
 * (`WITHDRAWN_BY_CONSULTANT`). The request CAS carries the money predicate in
 * its WHERE, so a capture that already flipped the row through the single
 * writer matches zero rows and nothing below runs. The open pay order is
 * tombstoned by status — Razorpay orders cannot be voided, and a capture that
 * lands on an EXPIRED Payment takes the handler's `captured_after_release`
 * refund arm — and the tentative holds are released by status, never deleted.
 */
export type LapseReason = "PAYMENT_LAPSED" | "WITHDRAWN_BY_CONSULTANT";

export interface LapseApprovedRequestArgs {
  kind: "consultation" | "subscription";
  id: string;
  reason: LapseReason;
  actorUserId: string | null;
}

export type LapseOutcome =
  | { moved: 0; appointmentId: null }
  | { moved: 1; appointmentId: string | null };

// The predicates the sweeps repeat in the CAS WHERE: no succeeded payment on
// the wrapper (#1554 — a subscription may have no wrapper yet).
const UNPAID_CONSULTATION = {
  appointment: {
    payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
  },
} as const;
const UNPAID_SUBSCRIPTION = {
  OR: [
    { appointment: null },
    {
      appointment: {
        payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
      },
    },
  ],
} as const;

type LapseTx = Pick<
  Tx,
  | "consultation"
  | "subscription"
  | "appointment"
  | "appointmentOccurrence"
  | "payment"
  | "bookingStatusHistory"
>;

/** Never throws on a lost CAS: `{ moved: 0 }` and no further write. */
export async function lapseApprovedRequest(
  tx: LapseTx,
  args: LapseApprovedRequestArgs,
): Promise<LapseOutcome> {
  const meta = {
    actorUserId: args.actorUserId,
    reason: args.reason,
    to: AppointmentStatus.EXPIRED,
    fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
    data: { pendingPaymentUrl: null },
  };
  try {
    if (args.kind === "consultation") {
      await transitionConsultationRequest(tx, {
        ...meta,
        where: { id: args.id, ...UNPAID_CONSULTATION },
      });
    } else {
      await transitionSubscriptionRequest(tx, {
        ...meta,
        where: { id: args.id, ...UNPAID_SUBSCRIPTION },
      });
    }
  } catch (error) {
    if (error instanceof IllegalTransitionError)
      return { moved: 0, appointmentId: null };
    throw error;
  }

  const rel =
    args.kind === "consultation" ? "consultationId" : "subscriptionId";
  const appointment = await tx.appointment.findFirst({
    where: { [rel]: args.id, deletedAt: null },
    select: { id: true },
  });
  if (!appointment) return { moved: 1, appointmentId: null };

  await transitionOccurrenceCompletion(tx, {
    actorUserId: args.actorUserId,
    reason: args.reason,
    where: {
      appointmentId: appointment.id,
      isTentative: true,
      deletedAt: null,
    },
    to: OccurrenceCompletionStatus.CANCELLED,
    data: { deletedAt: new Date() },
    allowZero: true,
  });
  // Only a still-PENDING order expires; a capture that raced this write keeps
  // its SUCCEEDED row (the request CAS above already lost to it).
  await tx.payment.updateMany({
    where: {
      appointmentId: appointment.id,
      paymentStatus: PaymentStatus.PENDING,
    },
    data: { paymentStatus: PaymentStatus.EXPIRED },
  });
  return { moved: 1, appointmentId: appointment.id };
}
