import { notFound } from "next/navigation";

import { LibraryPage } from "@/components/dashboard/library/LibraryPage";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { libraryScopeFor } from "@/lib/library/library-query";

/**
 * Library › Session documents | Session recordings. Every member, SUSPENDED
 * included, reads their own sessions' files; the Everyone scope is the same
 * gate the route applies.
 */
export default async function OrgLibraryRoute({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();

  const query = await searchParams;
  const requested = typeof query.scope === "string" ? query.scope : null;
  return (
    <LibraryPage
      title="Library"
      basePath={`/dashboard/organization/${orgId}/library`}
      tabs={["documents", "recordings"]}
      owner={{
        kind: "org",
        orgId,
        viewerId: access.session.user.id,
        scope: libraryScopeFor(requested, access.member),
        canSeeEveryone: libraryScopeFor("everyone", access.member) !== null,
      }}
      searchParams={query}
    />
  );
}
