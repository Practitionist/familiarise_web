import { notFound } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { isPayerAdminRole } from "@/lib/booking/org-actor";
import {
  CANCELLABLE_FROM,
  RESCHEDULABLE_FROM,
} from "@/lib/booking/transitions";
import {
  appointmentViewerSides,
  readAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";

import DetailPageClient from "./DetailPageClient";
import { DelivererDetailClient } from "./DelivererDetailClient";
import { OrgActorDetail, type OrgActorDetailProps } from "./OrgActorDetail";

type Appointment = TAppointmentDetail["appointment"];

/** ADR 20 metadata only: what the Everyone list already shows, no content. */
function toMetadata(appointment: Appointment): OrgActorDetailProps["meta"] {
  const booking = appointment.consultation ?? appointment.subscription;
  const plan =
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    appointment.trial?.subscriptionPlan ??
    null;
  return {
    title: plan?.title ?? "Session",
    kind: appointment.appointmentType,
    status: booking?.status ?? null,
    expertName: plan?.consultantProfile?.user?.name ?? null,
    learnerName: booking?.requestedBy?.user?.name ?? null,
    sessions: appointment.occurrences.map((o) => ({
      id: o.id,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
    })),
  };
}

/**
 * One org appointment. Three views, checked in order (#1527 §7.3):
 *
 *   1. The attendee — the full consultee detail, as before.
 *   2. The deliverer — experts used to 404 on sessions they delivered; they
 *      now get the consultant detail, kept inside the org dashboard.
 *   3. Operators — `operations.read` sees the ADR 20 metadata the Everyone list
 *      shows; OWNER/MAINTAINER of the funding org may also cancel or ask to
 *      reschedule a 1:1 booking from it (Q11), which the API already allows
 *      via `isOrgAdminOfAppointment`.
 *
 * Both ids come from the URL and neither constrains the other, so the page
 * first proves membership, then that the appointment is THIS org's, and only
 * then which of the three the caller is (#1029). Every branch fails closed
 * with notFound(), which never confirms that an appointment exists.
 */
export default async function OrgAppointmentDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; appointmentId: string }>;
}) {
  const { orgId, appointmentId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  const userId = access.session.user.id;

  const [detail, profile, consultantProfile] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    prisma.consultantProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
  ]);
  if (!detail) notFound();

  const { appointment } = detail;

  // Belongs to THIS org — not merely to some org.
  if (appointment.organizationId !== orgId) notFound();

  // 1. The caller is on it. Mirrors the consultee detail page's participation
  // test: requester, trial consultee, or a live seat holder (#1554).
  const owns =
    profile !== null &&
    (appointment.consultation?.requestedBy?.id === profile.id ||
      appointment.subscription?.requestedBy?.id === profile.id ||
      appointment.trial?.consulteeProfile?.id === profile.id ||
      appointment.participants.some((seat) => seat.userId === userId));
  if (owns) {
    return (
      <DetailPageClient
        orgId={orgId}
        appointmentId={appointmentId}
        consulteeId={profile.id}
      />
    );
  }

  // 2. The caller delivers it (plan consultant or accepted collaborator).
  if (
    consultantProfile &&
    appointmentViewerSides(userId, detail).asConsultant
  ) {
    return (
      <DelivererDetailClient
        orgId={orgId}
        appointmentId={appointmentId}
        consultantId={consultantProfile.id}
      />
    );
  }

  // 3. Operators read metadata; the funding org's payer admins may act.
  const role = access.member.role;
  const actsForOrg = isPayerAdminRole(role);
  if (!actsForOrg && !hasOrgPermission(role, "operations.read")) notFound();

  const booking = appointment.consultation ?? appointment.subscription;
  // Q11 covers the org's own 1:1 bookings; a group event's cancel is the
  // host's call and refunds every seat, so it is never offered here.
  const status = booking?.status ?? null;

  return (
    <OrgActorDetail
      orgId={orgId}
      orgName={access.org.name}
      appointmentId={appointmentId}
      meta={toMetadata(appointment)}
      canCancel={
        actsForOrg && status !== null && CANCELLABLE_FROM.includes(status)
      }
      canReschedule={
        actsForOrg && status !== null && RESCHEDULABLE_FROM.includes(status)
      }
      isSubscription={appointment.subscription !== null}
    />
  );
}
