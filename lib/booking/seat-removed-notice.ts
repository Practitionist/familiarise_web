import prisma from "@/lib/prisma";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";

/** A host removed the seat: the attendee is told whatever their switches say, with the refund's state when one is still settling. */
export async function notifySeatRemoved(args: {
  appointmentId: string;
  attendeeUserId: string;
  /** Set while a refund is pending at the gateway; its settlement sends the refund notice. */
  refundText?: string;
  /** A conduct removal: the host's reason and the support case, and the case page to open. */
  removal?: { note: string; href: string };
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
  const dashboardUrl =
    args.removal?.href ??
    notificationHref(appointment.organizationId, "appointments");
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
        seatRemoved: true,
        ...(args.removal ? { removalNote: args.removal.note } : {}),
      },
      {
        required: { kind: "SEAT_RELEASED", recipients: [args.attendeeUserId] },
      },
    ),
    stageAppointmentCancelledEmail(prisma, {
      appointmentId: args.appointmentId,
      userIds: [args.attendeeUserId],
      requiredFor: [args.attendeeUserId],
      ...(args.removal ? { reason: args.removal.note } : {}),
      ...(args.refundText
        ? { refundText: args.refundText, refundUserIds: [args.attendeeUserId] }
        : {}),
      removedFrom: {
        eventLabel: appointment.class ? "class" : "webinar",
        planTitle: planTitleOrSessionLabel(
          plan?.title,
          appointment.appointmentType,
        ),
      },
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
