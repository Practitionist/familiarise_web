import Link from "next/link";
import { notFound } from "next/navigation";
import { Inbox } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { CreateTicketDialog } from "@/components/dashboard/shared/support/CreateTicketDialog";
import { OrgSupportRequests } from "./OrgSupportRequests";
import { ViewerZone } from "@/app/support/_components/ViewerZone";

export default async function OrganizationSupportPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string }> }>) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) notFound();
  const canRead = hasOrgPermission(access.member.role, "supportRequests.org");
  const canCreate =
    canRead &&
    access.session.user.role !== "ADMIN" &&
    access.session.user.role !== "STAFF";
  const ownershipScope = hasOrgPermission(
    access.member.role,
    "supportCases.operations.manage",
  )
    ? "ORG_OPERATIONS"
    : "ORG_BILLING";
  return (
    <ViewerZone>
      <PageHeader
        headingLevel={2}
        title="Support cases"
        description="Your organization’s operations and billing conversations with the Familiarise team."
        actions={
          canCreate ? (
            <CreateTicketDialog
              defaults={{ organizationId: orgId, ownershipScope }}
            />
          ) : undefined
        }
      />
      {canRead ? (
        <OrgSupportRequests orgId={orgId} />
      ) : (
        <EmptyState
          icon={Inbox}
          title="Get help with an organization appointment"
          description="Open an appointment to raise a personal concern. Organization-owned conversations are handled by authorized team members."
          action={
            <Button variant="outline" asChild>
              <Link href={`/dashboard/organization/${orgId}/appointments`}>
                View appointments
              </Link>
            </Button>
          }
        />
      )}
    </ViewerZone>
  );
}
