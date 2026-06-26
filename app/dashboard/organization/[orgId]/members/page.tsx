import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  canSeeOperatorSurface,
  canSeeFinanceSurface,
} from "@/lib/auth/role-ranks";
import { MembersPageClient } from "./MembersPageClient";
import { getOrgMembers } from "@/lib/data/org-members";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // Mirror GET /api/organizations/[orgId]/members — bare membership + the
  // operator-or-finance surface floor (#777). The roster is operational, not
  // member-facing, so guard before the SSR prefetch dehydrates it.
  const access = await requireOrgAccess(orgId);
  if (
    access.error ||
    (!canSeeOperatorSurface(access.member.role) &&
      !canSeeFinanceSurface(access.member.role))
  ) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-members", orgId],
      queryFn: () => getOrgMembers(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
