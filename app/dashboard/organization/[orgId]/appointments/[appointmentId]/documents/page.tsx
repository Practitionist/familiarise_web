import { notFound, redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { DocumentsWorkspacePage } from "@/components/documents/workspace/DocumentsWorkspacePage";
import { resolveDocumentParty } from "@/lib/documents/document-party";

/** An org session's Documents workspace, for its two parties only; other org roles go back to the session summary. */
export default async function OrgAppointmentDocumentsPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string; appointmentId: string }> }>) {
  const { orgId, appointmentId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();
  const userId = access.session.user.id;
  const hubHref = `/dashboard/organization/${orgId}/appointments/${appointmentId}`;

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, organizationId: orgId, deletedAt: null },
    select: { id: true },
  });
  if (!appointment) notFound();
  if (!(await resolveDocumentParty(prisma, appointmentId, userId))) {
    redirect(hubHref);
  }
  return (
    <DocumentsWorkspacePage
      appointmentId={appointmentId}
      userId={userId}
      backHref={hubHref}
      role={null}
    />
  );
}
