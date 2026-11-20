import type { RescheduleInitiatorRole } from "@prisma/client";

import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { withAppointmentLock } from "@/utils/appointmentlock";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "@/lib/booking/transitions";
import {
  reportPartialRestore,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { notifyRescheduleRestored } from "@/lib/booking/reschedule-outcome-notice";
import {
  actsForRescheduleSide,
  consulteeUserIdOf,
  isSuspendedLearnerOf,
  RESCHEDULE_SIDE_APPOINTMENT_SELECT,
} from "@/lib/booking/reschedule-side";

const EXPERT_USER = {
  select: { consultantProfile: { select: { userId: true } } },
} as const;

/** The side check's fields, plus the plan's expert, the consultant side's own party. */
const WITHDRAW_APPOINTMENT_SELECT = {
  ...RESCHEDULE_SIDE_APPOINTMENT_SELECT,
  consultation: {
    select: {
      ...RESCHEDULE_SIDE_APPOINTMENT_SELECT.consultation.select,
      consultationPlan: EXPERT_USER,
    },
  },
  subscription: {
    select: {
      ...RESCHEDULE_SIDE_APPOINTMENT_SELECT.subscription.select,
      subscriptionPlan: EXPERT_USER,
    },
  },
} as const;

/** What {@link rescheduleWithdrawAuthority} reads off an open request. */
export const WITHDRAW_AUTHORITY_SELECT = {
  initiatedById: true,
  initiatorRole: true,
  appointment: { select: WITHDRAW_APPOINTMENT_SELECT },
} as const;

type ExpertUser = { consultantProfile: { userId: string } };

export type WithdrawableRequest = {
  initiatedById: string;
  initiatorRole: RescheduleInitiatorRole;
  appointment: {
    consultationId: string | null;
    subscriptionId: string | null;
    organizationId: string | null;
    consultation: {
      requestedBy: { userId: string };
      consultationPlan: ExpertUser;
    } | null;
    subscription: {
      requestedBy: { userId: string };
      subscriptionPlan: ExpertUser;
    } | null;
    trial: {
      consultantProfileId: string;
      consulteeProfile: { userId: string };
    } | null;
  };
};

export type WithdrawAuthority =
  | { allowed: true; sameSideActor: boolean }
  | {
      allowed: false;
      refusal: "NOT_FOUND" | "NO_LONGER_A_PARTY" | "MEMBERSHIP_SUSPENDED";
    };

/**
 * Whether this caller may withdraw an open reschedule. Its initiator may,
 * while they still act for the side they opened it from. A move an
 * organisation actor opened may also be withdrawn by anyone acting for that
 * same side (the learner for a sponsor admin's, the plan's expert for a
 * host-org operator's); a move the side's own party opened is theirs alone. A
 * learner suspended in the funding organisation moves nothing. The withdraw
 * route and the booking detail's Withdraw button both ask here.
 */
export async function rescheduleWithdrawAuthority(
  open: WithdrawableRequest,
  session: Session,
): Promise<WithdrawAuthority> {
  const isInitiator = open.initiatedById === session.user.id;
  const actsForSide = await actsForRescheduleSide(
    open.initiatorRole,
    open.appointment,
    session,
  );
  const sidePartyUserId =
    open.initiatorRole === "CONSULTEE"
      ? consulteeUserIdOf(open.appointment)
      : (open.appointment.consultation?.consultationPlan.consultantProfile
          .userId ??
        open.appointment.subscription?.subscriptionPlan.consultantProfile
          .userId);
  const sameSideActor =
    !isInitiator && actsForSide && open.initiatedById !== sidePartyUserId;
  if (!isInitiator && !sameSideActor) {
    return { allowed: false, refusal: "NOT_FOUND" };
  }
  if (!actsForSide) return { allowed: false, refusal: "NO_LONGER_A_PARTY" };
  if (await isSuspendedLearnerOf(open.appointment, session.user.id)) {
    return { allowed: false, refusal: "MEMBERSHIP_SUSPENDED" };
  }
  return { allowed: true, sameSideActor };
}

/**
 * The initiating side takes its reschedule back, and the booking returns to
 * exactly what it was, through the restore expiry and decline share
 * (`lib/booking/reschedule-restore.ts`).
 */
export async function withdrawRescheduleRequest(args: {
  rescheduleRequestId: string;
  /** The initiator, unless `sameSideActor` is set. */
  withdrawnById: string;
  /**
   * The caller proved the withdrawer acts for the initiator's side of a move
   * an organisation actor opened, so they need not be the initiator.
   */
  sameSideActor?: boolean;
  /** False when the counterparty never heard of the request, so no notice goes out. */
  notify?: boolean;
}): Promise<{ withdrawn: boolean; reason?: string }> {
  const {
    rescheduleRequestId,
    withdrawnById,
    sameSideActor = false,
    notify = true,
  } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      status: true,
      initiatedById: true,
      releasedOccurrenceIds: true,
      appointmentId: true,
      createdAt: true,
      originStatus: true,
      appointment: {
        select: {
          consultationId: true,
          subscriptionId: true,
        },
      },
    },
  });

  if (!request) return { withdrawn: false, reason: "PROPOSAL_NOT_FOUND" };

  // Withdrawal belongs to the initiating side. The other side already has
  // Decline, which ends the same request with a different meaning and a
  // different outcome for the slots — giving them this too would just be a
  // second Decline wearing a friendlier word.
  if (!sameSideActor && request.initiatedById !== withdrawnById) {
    return { withdrawn: false, reason: "NOT_INITIATOR" };
  }
  if (!RESCHEDULE_OPEN_STATUSES.includes(request.status)) {
    return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
  }

  let restored = 0;
  try {
    // #1583 A-P0-04 — the withdraw is a lifecycle mutation like accept and
    // cancel; it serialises on the appointment atom, and the tx opens inside.
    await withAppointmentLock(request.appointmentId, () =>
      prisma.$transaction(async (tx) => {
        // The CAS is the guard: if the other party answered while we were
        // deciding, this matches zero rows and throws rather than un-releasing
        // slots that a concurrent accept has already re-confirmed.
        await transitionRescheduleRequest(tx, {
          actorUserId: withdrawnById,
          appointmentId: request.appointmentId,
          where: { id: request.id },
          to: "WITHDRAWN",
          data: { resolvedById: withdrawnById },
        });

        restored = await restoreRescheduledBooking(tx, request, {
          actorUserId: withdrawnById,
          reason: "reschedule withdrawn",
          op: "reschedule-withdraw",
        });
      }),
    );
  } catch (err) {
    // A lost CAS is a MODELLED outcome, not a fault: the other party accepted
    // or declined while this withdrawal was in flight. Reporting it as an error
    // would page on ordinary two-party contention, and the route would answer
    // 500 instead of the 409 this actually is.
    if (err instanceof IllegalTransitionError) {
      return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    // #1846 SM-B15 — the original time was booked while the proposal was open,
    // so flipping the released rows back to confirmed hits the overlap
    // constraint. The transaction rolled back whole, so the proposal is still
    // open and nothing moved; that is an answer (409), not a fault (500).
    if (isExclusionViolation(err)) {
      return { withdrawn: false, reason: "ORIGINAL_TIME_TAKEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-withdraw",
      extra: {
        rescheduleRequestId,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
      },
    });
    throw err;
  }

  reportPartialRestore(request, restored, "reschedule-withdraw");

  // PR 2e — the initiator withdrew their own proposal; both parties learn
  // the booking stays at its original times.
  if (notify) {
    await notifyRescheduleRestored(
      rescheduleRequestId,
      "WITHDRAWN",
      EMAIL_BUDGET_MS.REQUEST,
    );
  }

  return { withdrawn: true };
}
