import { notFound, redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import prisma from "@/lib/prisma";
import { supportRequestsHref } from "@/lib/dashboard/account-href";
import { attachmentCaseAccess } from "@/lib/support/case-attachments";
import { sessionRole } from "@/lib/auth/session-role";

/** Notification links resolve to an authorized dashboard; they never render a separate evidence UI. */
export default async function EvidenceLink({
  params,
}: Readonly<{ params: Promise<{ requestId: string }> }>) {
  const { user } = await requireOnboarded();
  const { requestId } = await params;
  const row = await prisma.supportCaseEvidenceRequest.findFirst({
    where: { id: requestId, recipientUserId: user.id },
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
  const inbox = supportRequestsHref(user);
  if (inbox) redirect(`${inbox}/evidence/${requestId}`);
  redirect(`/dashboard/support/c_${row.caseId}`);
}
