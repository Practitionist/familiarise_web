import { notFound, redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { sessionRole } from "@/lib/auth/session-role";
import { parseCaseKey } from "@/lib/support/case-key";
import { resolveSupportCaseId } from "@/lib/support/case-workspace";
import { readSupportCaseForViewer } from "@/lib/support/case-service";
export default async function CaseLink({
  params,
}: {
  params: Promise<{ caseKey: string }>;
}) {
  const { user } = await requireOnboarded();
  const { caseKey } = await params;
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "booking") notFound();
  const caseId = await resolveSupportCaseId(ref);
  if (!caseId) notFound();
  const staff = hasBackofficePermission(
    sessionRole(user.role),
    "tickets.manage",
  );
  const view = await readSupportCaseForViewer(caseId, {
    userId: user.id,
    role: sessionRole(user.role),
    isStaff: staff,
  });
  if (!view) notFound();
  const key = `c_${caseId}`;
  if (staff)
    redirect(
      `/dashboard/${user.role === "ADMIN" ? "admin" : "staff"}/support/${key}`,
    );
  if (
    view.organizationId &&
    "ownershipScope" in view &&
    view.ownershipScope !== "PERSONAL"
  )
    redirect(
      `/dashboard/organization/${view.organizationId}/support/requests/${key}`,
    );
  if (user.role === "ORG_WORKSPACE" && user.orgWorkspaceProfileId)
    redirect(
      `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/support/requests/${key}`,
    );
  if (user.role === "CONSULTANT" && user.consultantProfileId)
    redirect(
      `/dashboard/consultant/${user.consultantProfileId}/support/requests/${key}`,
    );
  if (user.consulteeProfileId)
    redirect(
      `/dashboard/consultee/${user.consulteeProfileId}/support/requests/${key}`,
    );
  redirect("/dashboard");
}
