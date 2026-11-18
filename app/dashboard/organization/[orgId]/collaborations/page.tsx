import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { deliversForOrg } from "@/lib/dashboard/nav/organization";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";

/**
 * Collaborators on this org's hosted webinar and class plans. The server picks
 * the view: operators (`catalog.manage`) read every hosted plan whoever
 * delivers it; any other delivering member reads their own plans. Both need
 * `canHost`. B2C plans stay on the personal consultant dashboard.
 */
export default async function OrgCollaborationsPage({
  params,
}: Readonly<{
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    canHost: true,
  });
  if (access.error) notFound();

  const orgView = hasOrgPermission(access.member.role, "catalog.manage");
  if (!orgView && !deliversForOrg(access.member)) notFound();

  return (
    <>
      <DashboardHeader
        title="Collaborations"
        description={
          orgView
            ? `The team on every webinar and class ${access.org.name} hosts: invite, change a pending invitation, or remove a collaborator.`
            : `Invitations to answer, the plans you help deliver, and the teams on your own webinars and classes at ${access.org.name}.`
        }
      />
      <DashboardContent>
        <InvitationsPanel orgScope={orgId} orgView={orgView} />
      </DashboardContent>
    </>
  );
}
