import { HydrationBoundary } from "@tanstack/react-query";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readDocumentLibrary } from "@/lib/data/document-library";
import { libraryKeys } from "@/lib/documents/query-keys";
import { parseLibraryQuery } from "@/lib/library/library-query";
import { seedLibraryPage } from "@/lib/library/library-seed";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

export default async function ConsulteeDocumentsRoute({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consulteeId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  const viewerZone = await getViewerZone();
  const seed = await seedLibraryPage({
    name: "documents:learner",
    queryKey: libraryKeys.personal("documents", "consultee", consulteeId),
    searchParams: await searchParams,
    // An inspecting operator's list is read by the route as the profile's owner.
    skip: access.isInspecting,
    read: () =>
      readDocumentLibrary({
        userId: access.userId,
        owner: { kind: "personal", side: "learner" },
        query: parseLibraryQuery(() => null),
      }),
  });
  return (
    <>
      <DashboardHeader
        title="Session documents"
        description="Files you shared with your experts, their replies, and plan materials. Open a booking to upload or ask for changes."
      />
      <DashboardContent>
        <DisplayZoneProvider zone={viewerZone.zone}>
          <HydrationBoundary state={seed}>
            <PersonalLibrary
              tree="consultee"
              profileId={consulteeId}
              artifact="documents"
            />
          </HydrationBoundary>
        </DisplayZoneProvider>
      </DashboardContent>
    </>
  );
}
