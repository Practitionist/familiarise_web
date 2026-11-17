import { notFound } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import { sessionRole } from "@/lib/auth/session-role";
import prisma from "@/lib/prisma";
import { attachmentCaseAccess } from "@/lib/support/case-attachments";
import { evidenceAppointmentScope } from "@/lib/support/evidence-scope";
import { EvidenceRequest } from "@/components/support/EvidenceInbox";

export async function DashboardEvidencePage({
  requestId,
  basePath,
  organizationId,
}: Readonly<{ requestId: string; basePath: string; organizationId?: string }>) {
  const { user } = await requireOnboarded();
  const row = await prisma.supportCaseEvidenceRequest.findFirst({
    where: {
      id: requestId,
      recipientUserId: user.id,
      supportCase: {
        deletedAt: null,
        ...(organizationId
          ? { appointment: evidenceAppointmentScope(organizationId) }
          : {}),
      },
    },
    select: { caseId: true },
  });
  if (
    !row ||
    !(await attachmentCaseAccess(
      row.caseId,
      { userId: user.id, role: sessionRole(user.role) },
      requestId,
    ))
  )
    notFound();
  return (
    <EvidenceRequest
      requestId={requestId}
      inboxHref={`${basePath}/support/evidence`}
    />
  );
}
