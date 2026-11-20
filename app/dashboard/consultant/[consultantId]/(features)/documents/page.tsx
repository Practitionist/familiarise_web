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
import { getPersonalViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

export default async function ConsultantDocumentsRoute({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  const viewerZone = await getPersonalViewerZone("consultant", consultantId);
  const seed = await seedLibraryPage({
    name: "documents:expert",
    queryKey: libraryKeys.personal("documents", "consultant", consultantId),
    searchParams: await searchParams,
    // An inspecting operator's list is read by the route as the profile's owner.
    skip: access.isInspecting,
    read: () =>
      readDocumentLibrary({
        userId: access.userId,
        owner: { kind: "personal", side: "expert" },
        query: parseLibraryQuery(() => null),
      }),
  });
  return (
    <>
      <DashboardHeader
        title="Session documents"
        description="Your learners' files and your replies, by booking. Open a booking to review."
      />
      <DashboardContent>
        <DisplayZoneProvider zone={viewerZone.zone}>
          <HydrationBoundary state={seed}>
            <PersonalLibrary
              tree="consultant"
              profileId={consultantId}
              artifact="documents"
            />
          </HydrationBoundary>
        </DisplayZoneProvider>
      </DashboardContent>
    </>
  );
}
