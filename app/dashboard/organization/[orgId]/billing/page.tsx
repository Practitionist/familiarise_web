import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { BillingPageClient } from "./BillingPageClient";
import { prefetchOrgBilling } from "@/lib/server/org-prefetch";

export default async function OrgBillingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-billing", orgId],
      queryFn: () => prefetchOrgBilling(orgId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <BillingPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
