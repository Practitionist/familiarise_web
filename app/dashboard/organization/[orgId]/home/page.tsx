import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { HomePageClient } from "./HomePageClient";
import { getOrgAnalytics } from "@/lib/data/org-analytics";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // /home is the universal landing page for every org role, so don't gate
  // the whole page. Only the analytics aggregate is MANAGER-scoped (mirrors
  // GET /api/organizations/[orgId]/analytics + the client's `enabled:
  // isOperator || isFinanceLead`), so guard just the prefetch — lower roles
  // still get their overview, they simply don't dehydrate manager data.
  const access = await requireOrgAccess(orgId, "MANAGER");

  // queryKey MUST match HomePageClient's analytics useQuery
  // (["org-analytics", orgId]) or hydration won't apply. The home page's
  // primary read is the analytics aggregate — same key + payload the
  // analytics page uses; its secondary ["org-activity", orgId] read stays
  // client-only.
  if (!access.error) {
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-analytics", orgId],
        queryFn: () => getOrgAnalytics(orgId),
      }),
    ]);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
