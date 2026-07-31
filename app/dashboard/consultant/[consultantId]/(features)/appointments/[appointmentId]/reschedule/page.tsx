import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { buildRescheduleSubject } from "@/lib/scheduling/slot-picker-subject";

import { RescheduleClient } from "./RescheduleClient";

/**
 * The consultant's reschedule surface.
 *
 * Required, not extra. The consultant's appointments rows used to open the
 * consultee's dialog; the consultee ROUTE checks
 * `requirePersonalProfileAccess("consultee", …)`, which a consultant fails —
 * so this is what keeps consultants able to reschedule once that dialog is
 * gone. Same picker, same policy shape, different auth and copy.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

export default async function ConsultantReschedulePage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) notFound();

  // The route's consultant must own the plan or be an ACCEPTED collaborator.
  // Mirrors the detail page: this binds the appointment to the URL's
  // consultant, the guard above binds that consultant to the session.
  const { appointment } = detail;
  const planOwnerIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.id,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id,
    appointment.webinar?.webinarPlan?.consultantProfile?.id,
    appointment.class?.classPlan?.consultantProfile?.id,
    appointment.trialSession?.subscriptionPlan?.consultantProfile?.id,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (collaborator) => collaborator.consultantProfile?.id,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (collaborator) => collaborator.consultantProfile?.id,
    ),
  ];
  if (!planOwnerIds.includes(consultantId)) notFound();

  const resolved = buildRescheduleSubject(detail);
  if (!resolved) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/appointments`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DashboardHeader
        title="Reschedule"
        subtitle={`Propose a new time for ${resolved.title}`}
      />

      <Link
        href={backHref}
        className="self-start text-sm font-medium underline underline-offset-4"
      >
        Back to appointments
      </Link>

      <RescheduleClient
        consultantId={consultantId}
        appointmentId={appointmentId}
        title={resolved.title}
        typeLabel={resolved.typeLabel}
        subject={resolved.subject}
        backHref={backHref}
      />
    </div>
  );
}
