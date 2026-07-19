/**
 * #appt-support — build the immutable SupportContext for a thread. Resolved once
 * per turn and passed to whichever resolver (flowchart / AI / human), so none of
 * them re-query or diverge, and a hand-off never loses context.
 */

import prisma from "@/lib/prisma";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "@/lib/payments/operations/cancellation-policy";
import type { SupportContext } from "./types";

/**
 * Assemble the context for (appointment, user). Returns null if the appointment
 * doesn't exist. Trusts its caller for authz (the user must participate).
 */
export async function buildSupportContext(
  threadId: string,
  appointmentId: string,
  userId: string,
): Promise<SupportContext | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      cancellationPolicySnapshot: true,
      slotsOfAppointment: {
        where: { completionStatus: "SCHEDULED" },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
      payment: {
        where: { paymentStatus: "SUCCEEDED", amount: { gt: 0 } },
        select: { id: true, amount: true },
        take: 1,
      },
      consultation: {
        select: { consultationPlan: { select: { consultantProfileId: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { consultantProfileId: true } } },
      },
      webinar: { select: { webinarPlan: { select: { consultantProfileId: true } } } },
      class: { select: { classPlan: { select: { consultantProfileId: true } } } },
    },
  });
  if (!appt) return null;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  const planConsultantId =
    appt.consultation?.consultationPlan?.consultantProfileId ??
    appt.subscription?.subscriptionPlan?.consultantProfileId ??
    appt.webinar?.webinarPlan?.consultantProfileId ??
    appt.class?.classPlan?.consultantProfileId ??
    null;
  const isProvider =
    !!me?.consultantProfileId && me.consultantProfileId === planConsultantId;

  const startsAt = appt.slotsOfAppointment[0]?.startsAt ?? null;

  // Recordings hang off the slot's meeting session, not the appointment directly
  // (Recording → MeetingSession → SlotOfAppointment → Appointment).
  const recording = await prisma.recording.findFirst({
    where: { meetingSession: { slotOfAppointment: { appointmentId } } },
    select: { id: true },
  });

  // Policy refund % if cancelled now (consultee-initiated). Only meaningful when
  // there's a policy snapshot + a start time; the caller re-derives the real
  // amount at execution time (this is a preview for the flow).
  let refundPctIfCancelledNow: number | null = null;
  if (appt.cancellationPolicySnapshot && startsAt) {
    const hoursUntilStart = (startsAt.getTime() - Date.now()) / 3_600_000;
    refundPctIfCancelledNow = computeRefundPct(
      parsePolicySnapshot(appt.cancellationPolicySnapshot),
      hoursUntilStart,
      false,
    );
  }

  return {
    threadId,
    appointmentId: appt.id,
    userId,
    organizationId: appt.organizationId,
    appointmentType: appt.appointmentType,
    isOrgContext: appt.organizationId !== null,
    isProvider,
    startsAt,
    refundPctIfCancelledNow,
    paymentId: appt.payment[0]?.id ?? null,
    // moneyResultExtensions has already converted the BigInt column → number paise.
    paymentAmountPaise: appt.payment[0]?.amount ?? null,
    hasRecording: !!recording,
  };
}
