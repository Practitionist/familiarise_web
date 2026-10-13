import { notFound } from "next/navigation";
import { HydrationBoundary } from "@tanstack/react-query";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { readRecordingLibrary } from "@/lib/data/recording-library";
import { libraryKeys } from "@/lib/documents/query-keys";
import {
  libraryScopeFor,
  parseLibraryQuery,
} from "@/lib/library/library-query";
import { seedLibraryPage } from "@/lib/library/library-seed";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

import { OrgLibraryPage } from "../OrgLibraryPage";

/**
 * /dashboard/organization/[orgId]/recordings — Library › Recordings (#1527). Every
 * member, SUSPENDED included, reads their own sessions' files; the Everyone
 * tab is the same gate the route applies.
 */
export default async function OrgRecordingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();

  const query = await searchParams;
  const requested = typeof query.scope === "string" ? query.scope : null;
  const scope = libraryScopeFor(requested, access.member);
  const viewerZone = await getViewerZone();
  const seed = await seedLibraryPage({
    name: "recordings:org",
    queryKey: libraryKeys.org(orgId, "recordings", scope ?? "mine"),
    fixedParams: { scope: scope ?? "mine" },
    searchParams: query,
    skip: scope === null,
    read: () =>
      readRecordingLibrary({
        userId: access.session.user.id,
        owner: { kind: "org", orgId, everyone: scope === "everyone" },
        query: parseLibraryQuery(() => null),
      }),
  });

  return (
    <DisplayZoneProvider zone={viewerZone.zone}>
      <HydrationBoundary state={seed}>
        <OrgLibraryPage
          orgId={orgId}
          artifact="recordings"
          canSeeEveryone={libraryScopeFor("everyone", access.member) !== null}
        />
      </HydrationBoundary>
    </DisplayZoneProvider>
  );
}
