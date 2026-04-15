import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { HomePageClient } from "./HomePageClient";
import {
  prefetchOrgAnalytics,
  prefetchOrgBilling,
} from "@/lib/server/org-prefetch";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-analytics", orgId],
      queryFn: () => prefetchOrgAnalytics(orgId),
    }),
    queryClient.prefetchQuery({
      queryKey: ["org-billing", orgId],
      queryFn: () => prefetchOrgBilling(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
