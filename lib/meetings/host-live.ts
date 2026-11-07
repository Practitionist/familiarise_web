// "Host is live": one optional bell to a session's paid seats, staged when the host's client
// reports its first successful call join (`POST /api/meetings/[meetingId]/host-live`).

import { appointmentDashboardUrl } from "@/lib/appointments/calendar-links";
import { paidParticipant } from "@/lib/booking/participants";
import {
  appointmentTypeLabel,
  planTitleOrSessionLabel,
} from "@/lib/novu/humanize";
import { stagePages, type StagedTrigger } from "@/lib/novu/outbox";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import prisma from "@/lib/prisma";

export const HOST_LIVE_CLAIM_SCOPE = "meeting.host-live";
/** Longer than any session plus its rejoin grace; the auth-token sweep prunes it after. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const NAMED_PLAN = {
  select: {
    title: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

/**
 * Claims the occurrence and stages its bell pages (one attempt's worth each) in one
 * transaction, so only the first admitted host join rings and a failed stage leaves the claim open.
 */
export async function stageHostLiveBell(
  occurrenceId: string,
): Promise<StagedTrigger[]> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    // Keyed on the occurrence alone: a rejoin, a reopened room or a second host claims nothing.
    const claim = await tx.idempotencyRecord.createMany({
      data: {
        scope: HOST_LIVE_CLAIM_SCOPE,
        key: occurrenceId,
        userId: occurrenceId,
        requestHash: occurrenceId,
        completedAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      },
      skipDuplicates: true,
    });
    if (claim.count === 0) return [];

    const occurrence = await tx.appointmentOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        appointment: {
          select: {
            id: true,
            organizationId: true,
            appointmentType: true,
            participants: {
              where: { ...paidParticipant(), role: "CONSULTEE" },
              select: { userId: true },
            },
            consultation: { select: { consultationPlan: NAMED_PLAN } },
            subscription: { select: { subscriptionPlan: NAMED_PLAN } },
            webinar: { select: { webinarPlan: NAMED_PLAN } },
            class: { select: { classPlan: NAMED_PLAN } },
            trial: { select: { subscriptionPlan: NAMED_PLAN } },
          },
        },
      },
    });
    const appointment = occurrence?.appointment;
    if (!appointment) return [];
    const plan =
      appointment.consultation?.consultationPlan ??
      appointment.subscription?.subscriptionPlan ??
      appointment.webinar?.webinarPlan ??
      appointment.class?.classPlan ??
      appointment.trial?.subscriptionPlan ??
      null;
    const workflowId = NOVU_WORKFLOWS.SESSION_HOST_LIVE;
    const { allowedRecipients } = await resolveRecipientBellPolicy(
      workflowId,
      appointment.participants.map((p) => p.userId),
      { tx },
    );
    return stagePages(tx, {
      workflowId,
      recipients: allowedRecipients,
      payload: {
        ...notificationScope(appointment.organizationId),
        appointmentType: appointmentTypeLabel(appointment.appointmentType),
        planTitle: planTitleOrSessionLabel(
          plan?.title,
          appointment.appointmentType,
        ),
        consultantName: plan?.consultantProfile?.user?.name || "Your host",
        dashboardUrl: appointmentDashboardUrl(appointment.id),
      },
      dedupeKey: `host-live:${occurrenceId}`,
      entityRef: `occurrence:${occurrenceId}`,
    });
  });
}
