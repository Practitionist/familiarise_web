import { notFound } from "next/navigation";

import { SupportRequestCasePage } from "@/app/support/_components/SupportRequestCasePage";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { goHref } from "@/lib/dashboard/go";

/**
 * #1527 — a member's own support request inside the org dashboard: "Get help"
 * on an org session and the operator's "Raise concern" land here. Membership
 * gates the page; the request itself must be the viewer's own (the API and
 * the ticket read both key on the session user).
 */
export default async function OrgSupportRequestPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string; caseKey: string }>;
  searchParams: Promise<{ intent?: string | string[] }>;
}>) {
  const [{ orgId, caseKey }, { intent }] = await Promise.all([
    params,
    searchParams,
  ]);
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) notFound();
  const base = `/dashboard/organization/${orgId}`;
  // The org Support page lists requests only for those who may triage them;
  // everyone else keeps theirs on their personal Support page.
  const supportHref = hasOrgPermission(
    access.member.role,
    "supportRequests.org",
  )
    ? `${base}/support`
    : goHref("auto", "support");
  return (
    <SupportRequestCasePage
      caseKey={caseKey}
      supportHref={supportHref}
      requestsBase={`${base}/support/requests`}
      appointmentsBase={`${base}/appointments`}
      intent={intent}
    />
  );
}
