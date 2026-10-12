import "server-only";

import prisma from "@/lib/prisma";
import { notifyRecordingRemoved } from "@/lib/novu/service";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import { notificationScope } from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";

/** Tells a booking's learners that the expert deleted one of its recordings. */
export async function notifyAttendeesOfRemovedRecording(args: {
  appointmentId: string;
  recordingTitle: string;
  consultantName: string;
}): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: args.appointmentId },
    select: {
      organizationId: true,
      consultation: { select: { requestedBy: { select: { userId: true } } } },
      subscription: { select: { requestedBy: { select: { userId: true } } } },
      trial: { select: { consulteeProfile: { select: { userId: true } } } },
      participants: {
        where: { role: "CONSULTEE", status: { in: ["CONFIRMED", "ATTENDED"] } },
        select: { userId: true },
      },
    },
  });
  if (!appointment) return;
  const userIds = [
    ...new Set(
      [
        appointment.consultation?.requestedBy.userId,
        appointment.subscription?.requestedBy.userId,
        appointment.trial?.consulteeProfile.userId,
        ...appointment.participants.map((p) => p.userId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  if (userIds.length === 0) return;
  const path = appointment.organizationId
    ? `/dashboard/organization/${appointment.organizationId}/appointments/${args.appointmentId}/recordings`
    : `/dashboard/go/auto/appointments/${args.appointmentId}/recordings`;
  await stageNowAttemptAfter("recording-removed notice", () =>
    notifyRecordingRemoved(
      userIds,
      {
        ...notificationScope(appointment.organizationId),
        recordingTitle: args.recordingTitle,
        consultantName: args.consultantName,
        dashboardUrl: `${getAppUrl()}${path}`,
      },
      { deferAttempt: true },
    ),
  );
}
