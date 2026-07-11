import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";


import { MembersPageClient } from "./MembersPageClient";
import { getOrgMembers } from "@/lib/data/org-members";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // members.read — the roster is an operator surface (BILLING_ADMIN is
  // operator-blind by role design; the old `|| finance` branch let it in).
  // Guard before the SSR prefetch dehydrates the roster.
  const access = await requireOrgAccess(orgId, { permission: "members.read" });
  if (access.error) {
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
