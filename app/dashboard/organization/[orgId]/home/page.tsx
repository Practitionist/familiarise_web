import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { HomePageClient } from "./HomePageClient";
import { getOrgAnalytics } from "@/lib/data/org-analytics";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // queryKey MUST match HomePageClient's analytics useQuery
  // (["org-analytics", orgId]) or hydration won't apply. The home page's
  // primary read is the analytics aggregate — same key + payload the
  // analytics page uses; its secondary ["org-activity", orgId] read stays
  // client-only.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-analytics", orgId],
      queryFn: () => getOrgAnalytics(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
