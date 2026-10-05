import { redirect } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { getOrgAnalytics, orgAnalyticsForRole } from "@/lib/data/org-analytics";
import { getOrgActivityFeed } from "@/lib/data/org-activity";

import { HomePageClient } from "./HomePageClient";

const OPERATOR_ROLES = new Set(["OWNER", "MAINTAINER", "MANAGER"]);

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  const baseAccess = await requireOrgAccess(orgId, { allowSuspended: true });
  if (baseAccess.error) {
    redirect("/dashboard");
  }

  // Only the operator home reads the analytics aggregate and activity feed,
  // so only operators get them seeded.
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (!access.error && OPERATOR_ROLES.has(access.member.role)) {
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-analytics", orgId],
        queryFn: async () => {
          const analytics = await getOrgAnalytics(orgId);
          return (
            analytics && orgAnalyticsForRole(analytics, access.member.role)
          );
        },
      }),
      queryClient.prefetchQuery({
        queryKey: ["org-activity", orgId],
        queryFn: () =>
          getOrgActivityFeed(orgId, access.member.role, 5).then((rows) => ({
            activity: rows,
          })),
      }),
    ]);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
