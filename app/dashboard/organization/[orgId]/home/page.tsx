import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { HomePageClient } from "./HomePageClient";
import { prefetchOrgDetails } from "@/lib/server/org-prefetch";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // queryKey MUST match HomePageClient's analytics useQuery
  // (["org-analytics", orgId]) or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-analytics", orgId],
      queryFn: () => prefetchOrgDetails(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
