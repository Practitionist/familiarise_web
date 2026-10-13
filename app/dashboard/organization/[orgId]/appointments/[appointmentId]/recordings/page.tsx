import { notFound, redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { RecordingSessionsPage } from "@/components/recordings/RecordingSessionsPage";

/** An org session's Recording details, for its host and entitled learners; other org roles go back to the session summary. */
export default async function OrgAppointmentRecordingsPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string; appointmentId: string }> }>) {
  const { orgId, appointmentId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();
  const hubHref = `/dashboard/organization/${orgId}/appointments/${appointmentId}`;
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, organizationId: orgId, deletedAt: null },
    select: { id: true },
  });
  if (!appointment) notFound();
  return (
    <RecordingSessionsPage
      appointmentId={appointmentId}
      userId={access.session.user.id}
      backHref={hubHref}
      role={null}
      onNotParty={() => redirect(hubHref)}
    />
  );
}
