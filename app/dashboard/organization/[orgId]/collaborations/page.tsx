/**
 * /dashboard/organization/[orgId]/collaborations — this org's hosted-plan
 * collaborators (#org-appts / #1025).
 *
 * Collaborators are split by the PLAN's org-ness, not the consultant's:
 * webinar/class plans with this org's organizationId are managed here;
 * B2C plans stay on the personal consultant dashboard. Received
 * invitations still aggregate personally either way — this page only
 * covers the host-perspective "my plans with collaborators" section.
 *
 * Access: members who deliver for the org (`deliversForOrg`, the nav's own
 * predicate — #1527). Operators read the org's hosted plans as Catalog ›
 * Collaborators (#1527-4c).
 */

import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { deliversForOrg } from "@/lib/dashboard/nav/organization";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";

export default async function OrgCollaborationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, { readOnly: true });
  // Same predicate as the nav item (#1527); operators use Catalog ›
  // Collaborators.
  if (access.error || !deliversForOrg(access.member)) {
    notFound();
  }

  return (
    <>
      <DashboardHeader
        title="Plan collaborators"
        description={`Invitations and active collaborations on ${access.org.name}'s webinar and class plans.`}
      />
      <DashboardContent>
        <InvitationsPanel orgScope={orgId} />
      </DashboardContent>
    </>
  );
}
