import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { libraryScopeFor } from "@/lib/library/library-query";

import { OrgLibraryPage } from "../OrgLibraryPage";

/**
 * /dashboard/organization/[orgId]/documents — Library › Documents (#1527). Every
 * member, SUSPENDED included, reads their own sessions' files; the Everyone
 * tab is the same gate the route applies.
 */
export default async function OrgDocumentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) notFound();

  return (
    <OrgLibraryPage
      orgId={orgId}
      artifact="documents"
      canSeeEveryone={libraryScopeFor("everyone", access.member) !== null}
    />
  );
}
