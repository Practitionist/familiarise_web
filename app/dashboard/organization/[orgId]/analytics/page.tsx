import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AnalyticsPageClient } from "./AnalyticsPageClient";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { getOrgAnalytics, withoutOrgMoney } from "@/lib/data/org-analytics";

export default async function OrgAnalyticsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // Mirror GET /api/organizations/[orgId]/analytics (operations.read, incl.
  // the SUPPORT carve-out) — the SSR prefetch reads org-scoped analytics
  // directly, so without this the dehydrated payload would embed
  // operations-only data for any member.
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) redirect(`/dashboard/organization/${orgId}/home`);

  const queryClient = new QueryClient();
  const seesMoney = hasOrgPermission(access.member.role, "billing.read");

  // queryKey MUST match AnalyticsPageClient's useQuery
  // (["org-analytics", orgId]) or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-analytics", orgId],
      // Same redaction as the API route (#1527): no paise for SUPPORT.
      queryFn: async () => {
        const analytics = await getOrgAnalytics(orgId);
        return analytics && !seesMoney ? withoutOrgMoney(analytics) : analytics;
      },
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AnalyticsPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
