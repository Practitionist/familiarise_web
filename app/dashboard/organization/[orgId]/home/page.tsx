import { redirect } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { getOrgAnalytics, orgAnalyticsForRole } from "@/lib/data/org-analytics";
import { getOrgActivityFeed } from "@/lib/data/org-activity";
import { resolveViewerZone } from "@/lib/time/viewer-zone";

import { HomePageClient } from "./HomePageClient";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  const baseAccess = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (baseAccess.error) {
    redirect("/dashboard");
  }

  // Only the operator home (the roles holding activity.read) reads the
  // analytics aggregate and activity feed, so only they get them seeded.
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "operations.read",
  });
  if (!access.error && hasOrgPermission(access.member.role, "activity.read")) {
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
          getOrgActivityFeed(
            orgId,
            access.member.role,
            resolveViewerZone({ userTimezone: access.session.user.timezone }),
            5,
          ).then((rows) => ({
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
