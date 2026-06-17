import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { MembersPageClient } from "./MembersPageClient";
import { getOrgMembers } from "@/lib/data/org-members";

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
      queryFn: () => getOrgMembers(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
