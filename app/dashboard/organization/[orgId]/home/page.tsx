import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { getOrgAnalytics, withoutOrgMoney } from "@/lib/data/org-analytics";
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

  // /home is every role's landing, so the page itself is not gated. Only the
  // operator home reads the analytics aggregate and activity feed (#1527 role
  // homes), so only operators get them seeded — SUPPORT holds
  // operations.read but its home is the support queue.
  // Keys MUST match OperatorHome's queries or hydration won't apply.
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (!access.error && OPERATOR_ROLES.has(access.member.role)) {
    const seesMoney = hasOrgPermission(access.member.role, "billing.read");
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-analytics", orgId],
        queryFn: async () => {
          const analytics = await getOrgAnalytics(orgId);
          return analytics && !seesMoney
            ? withoutOrgMoney(analytics)
            : analytics;
        },
      }),
      queryClient.prefetchQuery({
        queryKey: ["org-activity", orgId],
        queryFn: () =>
          getOrgActivityFeed(orgId, 5).then((rows) => ({ activity: rows })),
      }),
    ]);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
