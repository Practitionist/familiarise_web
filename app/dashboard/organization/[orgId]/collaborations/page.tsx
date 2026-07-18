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
 * Access: ANY active member (requireOrgAccess floors at that); the sidebar
 * additionally gates visibility on canHost + myArrangement.read (see
 * layout.tsx) since only host-capable orgs have collaborator-bearing plans.
 */

import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";

export default async function OrgCollaborationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Collaborations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage invitations and active collaborations on {access.org.name}
          &apos;s webinar and class plans.
        </p>
      </header>

      <InvitationsPanel orgScope={orgId} />
    </div>
  );
}
