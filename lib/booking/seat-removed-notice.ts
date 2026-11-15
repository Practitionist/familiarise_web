import prisma from "@/lib/prisma";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";

/**
 * An organiser removed a seat that owes no refund, so no refund notice tells
 * the attendee: they get the cancellation bell and email instead, whatever their switches say.
 */
export async function notifyFreeSeatRemoved(args: {
  appointmentId: string;
  attendeeUserId: string;
}): Promise<void> {
  const [appointment, attendee] = await Promise.all([
    prisma.appointment.findUnique({
      where: { id: args.appointmentId },
      select: {
        appointmentType: true,
        organizationId: true,
        occurrences: {
          where: { deletedAt: null, startsAt: { gt: new Date() } },
          orderBy: { startsAt: "asc" },
          take: 1,
          select: { startsAt: true },
        },
        webinar: { select: { webinarPlan: { select: planSelect } } },
        class: { select: { classPlan: { select: planSelect } } },
      },
    }),
    prisma.user.findUnique({
      where: { id: args.attendeeUserId },
      select: { name: true },
    }),
  ]);
  if (!appointment) return;
  const plan =
    appointment.webinar?.webinarPlan ?? appointment.class?.classPlan ?? null;
  const consultantName = plan?.consultantProfile?.user?.name || "The organiser";
  const startsAt = appointment.occurrences[0]?.startsAt ?? null;
  const dashboardUrl = notificationHref(
    appointment.organizationId,
    "appointments",
  );
  const [bells, emails] = await Promise.all([
    notifyAppointmentCancelled(
      [args.attendeeUserId],
      {
        ...notificationScope(appointment.organizationId),
        appointmentId: args.appointmentId,
        appointmentType: appointment.appointmentType,
        consultantName,
        consulteeName: attendee?.name || "Attendee",
        planTitle: planTitleOrSessionLabel(
          plan?.title,
          appointment.appointmentType,
        ),
        dateTime: startsAt?.toISOString(),
        dashboardUrl,
        cancelledBy: "consultant",
      },
      {
        required: { kind: "SEAT_RELEASED", recipients: [args.attendeeUserId] },
      },
    ),
    stageAppointmentCancelledEmail(prisma, {
      appointmentId: args.appointmentId,
      userIds: [args.attendeeUserId],
      requiredFor: [args.attendeeUserId],
      startsAt,
      cancelledBy: consultantName,
      dashboardUrl,
    }),
  ]);
  await flushNotificationsAfter(
    {
      bells: (bells ?? []).map((r) => r?.staged),
      emails: [{ rows: emails, emailType: "APPOINTMENT_CANCELLED" }],
    },
    "seat-leave.removed",
  );
}

const planSelect = {
  title: true,
  consultantProfile: { select: { user: { select: { name: true } } } },
} as const;
