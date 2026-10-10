import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { libraryScopeFor } from "@/lib/library/library-query";

import { OrgLibraryPage } from "../OrgLibraryPage";

/**
 * /dashboard/organization/[orgId]/recordings — Library › Recordings (#1527). Every
 * member, SUSPENDED included, reads their own sessions' files; the Everyone
 * tab is the same gate the route applies.
 */
export default async function OrgRecordingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();

  return (
    <OrgLibraryPage
      orgId={orgId}
      artifact="recordings"
      canSeeEveryone={libraryScopeFor("everyone", access.member) !== null}
    />
  );
}
