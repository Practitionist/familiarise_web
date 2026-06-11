import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { MembersPageClient } from "./MembersPageClient";
import { prefetchOrgMembers } from "@/lib/server/org-prefetch";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-members", orgId],
      queryFn: () => prefetchOrgMembers(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
