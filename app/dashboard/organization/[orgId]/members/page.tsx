import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";


import { MembersTabs } from "./MembersTabs";
import { getOrgMembers, ORG_MEMBERS_PER_PAGE } from "@/lib/data/org-members";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // members.directory — every member sees who is in the org (#1527
  // decision 3). The full roster stays members.read (BILLING_ADMIN is
  // operator-blind), so only that grant gets it prefetched below.
  const access = await requireOrgAccess(orgId, {
    permission: "members.directory",
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  if (!hasOrgPermission(access.member.role, "members.read")) {
    return <MembersTabs orgId={orgId} />;
  }

  const queryClient = new QueryClient();

  // #902 — the key + shape MUST match the client's first query
  // (["org-members", orgId, "", 1] → {members,total}) or hydration misses and
  // the roster re-fetches on mount (the bug this fixes).
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-members", orgId, "", 1],
      queryFn: () => getOrgMembers(orgId, { page: 1, perPage: ORG_MEMBERS_PER_PAGE }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersTabs orgId={orgId} />
    </HydrationBoundary>
  );
}
