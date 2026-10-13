import { notFound, permanentRedirect, redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { orgTabHref } from "@/lib/dashboard/org-tab-redirect";

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
 * The ALLOCATION surface is gated on the member holding a consultant profile
 * rather than on a permission key. Allocation is a delivery act — only the
 * person who delivers the session can choose its slots — so this is an
 * EXPERT-shaped surface even though `MemberRole.EXPERT` is not itself the gate:
 * an OWNER who also delivers has a consultant profile and belongs here.
 *
 * #1166 B2B gap 8 — a payer admin who does not deliver used to be redirected
 * away entirely, which cost them the one thing they do need: an org-funded
 * booking that no expert has scheduled is the org's money sitting idle, and the
 * only surface showing it was the delivering consultant's. Holders of
 * `appointments.unscheduled.read` (OWNER, MAINTAINER, MANAGER) get that list
 * read-only as Appointments › Unscheduled (#1527 Q7; this URL 308s there).
 * Everyone else still goes home, because they would be looking at a page with
 * nothing on it for them.
 */
export default async function OrgRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) {
    notFound();
  }

  // `Membership.consultantProfileId` is set when the member joined as an
  // EXPERT; the global profile is what the bookings endpoints key on.
  const consultantProfileId = access.member.consultantProfileId;

  if (!consultantProfileId) {
    if (
      !hasOrgPermission(access.member.role, "appointments.unscheduled.read")
    ) {
      redirect(`/dashboard/organization/${orgId}/home`);
    }
    // Keeps the old query like the other retired routes (#1527 QA wave 3).
    permanentRedirect(
      orgTabHref(orgId, "appointments", "unscheduled", await searchParams),
    );
  }

  return (
    <>
      <DashboardHeader
        title="Requests"
        description="Bookings under this organization awaiting slot allocation."
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
