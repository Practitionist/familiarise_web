import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { getOrgMembers } from "@/lib/data/org-members";
import {
  membersListKey,
  membersListQueryFromUrl,
} from "@/schemas/organizations";

import { MembersTabs } from "./MembersTabs";

const tabSchema = z.enum(["members", "invitations"]).catch("members");

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OrgMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const first = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // members.directory — every member sees who is in the org (#1527
  // decision 3). The full roster stays members.read (BILLING_ADMIN is
  // operator-blind), so only that grant gets it prefetched below.
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "members.directory",
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  const tab = tabSchema.parse(first("tab"));

  if (
    tab === "invitations" ||
    !hasOrgPermission(access.member.role, "members.read")
  ) {
    return <MembersTabs orgId={orgId} />;
  }

  // #902 — the key and shape MUST match the client's first query or
  // hydration misses and the roster re-fetches on mount.
  const query = membersListQueryFromUrl(first);
  const queryClient = new QueryClient();
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: membersListKey(orgId, query),
      queryFn: () =>
        getOrgMembers(orgId, query, {
          canSeePayout: hasOrgPermission(access.member.role, "payouts.read"),
        }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersTabs orgId={orgId} />
    </HydrationBoundary>
  );
}
