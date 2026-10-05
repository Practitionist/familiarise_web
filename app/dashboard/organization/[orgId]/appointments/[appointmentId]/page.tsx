import { notFound } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { canActForOrg } from "@/lib/booking/org-actor";
import {
  CANCELLABLE_FROM,
  RESCHEDULABLE_FROM,
} from "@/lib/booking/transitions";
import {
  appointmentViewerSides,
  readAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";

import DetailPageClient from "./DetailPageClient";
import { DelivererDetailClient } from "./DelivererDetailClient";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
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
  const status = (appointment.consultation?.status ??
    appointment.subscription?.status ??
    appointment.webinar?.status ??
    appointment.class?.status ??
    appointment.trial?.status ??
    null) as OrgActorDetailProps["meta"]["status"];
  return {
    title: plan?.title ?? "Session",
    kind: appointment.appointmentType,
    status,
    expertName: plan?.consultantProfile?.user?.name ?? null,
    learnerName:
      booking?.requestedBy?.user?.name ??
      appointment.trial?.consulteeProfile?.user?.name ??
      null,
    sessions: appointment.occurrences
      .filter((o) => !isDeadOccurrence(o))
      .map((o) => ({
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
 *      shows; the funding org's payer-side actors may also cancel or ask to
 *      reschedule a 1:1 booking from it (Q11, split by `canActForOrg`), as the API
 *      allows via `isOrgAdminOfAppointment`.
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

  // #1527 decision 6 — a SUSPENDED member may open their OWN session
  // (branches 1–2, read-only); the operator branch needs an ACTIVE grant.
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) {
    notFound();
  }
  const suspended = access.member.status === "SUSPENDED";

  const userId = access.session.user.id;

  const [detail, profile, consultantProfile, viewerZone] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    prisma.consultantProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    // One zone for the server render and hydration (#418, #1527 QA).
    getViewerZone(),
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
      <DisplayZoneProvider zone={viewerZone.zone}>
        <DetailPageClient
          orgId={orgId}
          appointmentId={appointmentId}
          consulteeId={profile.id}
          readOnly={suspended}
        />
      </DisplayZoneProvider>
    );
  }

  // 2. The caller delivers it (plan consultant or accepted collaborator).
  if (
    consultantProfile &&
    appointmentViewerSides(userId, detail).asConsultant
  ) {
    return (
      <DisplayZoneProvider zone={viewerZone.zone}>
        <DelivererDetailClient
          orgId={orgId}
          appointmentId={appointmentId}
          consultantId={consultantProfile.id}
          readOnly={suspended}
        />
      </DisplayZoneProvider>
    );
  }

  // 3. Operators read metadata; the funding org's payer-side actors may act —
  // MANAGER reschedules, cancel (it refunds) stays OWNER/MAINTAINER (#1527).
  if (suspended) notFound();
  const role = access.member.role;
  const mayCancel = canActForOrg(role, "cancel");
  const mayReschedule = canActForOrg(role, "reschedule");
  if (
    !mayCancel &&
    !mayReschedule &&
    !hasOrgPermission(role, "operations.read")
  ) {
    notFound();
  }

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
        mayCancel && status !== null && CANCELLABLE_FROM.includes(status)
      }
      canReschedule={
        mayReschedule && status !== null && RESCHEDULABLE_FROM.includes(status)
      }
      isSubscription={appointment.subscription !== null}
    />
  );
}
