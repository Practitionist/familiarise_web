import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { AnalyticsPageClient } from "./AnalyticsPageClient";
import { getOrgAnalytics } from "@/lib/data/org-analytics";

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
      queryFn: () => getOrgAnalytics(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AnalyticsPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
