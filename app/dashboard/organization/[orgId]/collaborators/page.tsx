import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";

/**
 * Every plan this org hosts and its collaborators, whoever delivers it, behind
 * Catalog's gate. Experts read their own as Plan collaborators.
 */
export default async function OrgCollaboratorsPage({
  params,
}: Readonly<{
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  return (
    <>
      <DashboardHeader
        title="Collaborators"
        description={`Invitations and active collaborations on ${access.org.name}'s webinar and class plans.`}
      />
      <DashboardContent>
        <InvitationsPanel orgScope={orgId} orgView />
      </DashboardContent>
    </>
  );
}
