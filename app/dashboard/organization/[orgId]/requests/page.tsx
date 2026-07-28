import { notFound, redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { DashboardHeader, DashboardContent } from "@/components/dashboard/PageScaffold";

import { RequestsClient } from "./RequestsClient";

/**
 * Requests — slot allocation for sessions this organization funded or hosts.
 *
 * This page exists because its absence had a cost. Allocation lived only in the
 * consultant tree, which fetches the bookings endpoints without an `orgScope`,
 * and those endpoints drop org-funded rows when the param is missing. So an
 * org-sponsored subscription could be paid for and never scheduled: the request
 * existed and no surface in the product would show it.
 *
 * Gated on the member holding a consultant profile rather than on a permission
 * key. Allocation is a delivery act — only the person who delivers the session
 * can choose its slots — so this is an EXPERT-shaped surface even though
 * `MemberRole.EXPERT` is not itself the gate: an OWNER who also delivers has a
 * consultant profile and belongs here, while an OWNER who does not deliver has
 * nothing to allocate and is sent back to the org home rather than shown an
 * empty page they cannot act on.
 */
export default async function OrgRequestsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  // `Membership.consultantProfileId` is set when the member joined as an
  // EXPERT; the global profile is what the bookings endpoints key on.
  const consultantProfileId = access.member.consultantProfileId;
  if (!consultantProfileId) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  return (
    <>
      <DashboardHeader
        title="Requests"
        subtitle="Bookings under this organization awaiting slot allocation."
      />
      <DashboardContent>
        <RequestsClient
          orgId={orgId}
          consultantProfileId={consultantProfileId}
        />
      </DashboardContent>
    </>
  );
}
