import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { AnalyticsPageClient } from "./AnalyticsPageClient";
import { prefetchOrgAnalytics } from "@/lib/server/org-prefetch";

export default async function OrgAnalyticsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // queryKey MUST match AnalyticsPageClient's useQuery
  // (["org-analytics", orgId]) or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-analytics", orgId],
      queryFn: () => prefetchOrgAnalytics(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AnalyticsPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
