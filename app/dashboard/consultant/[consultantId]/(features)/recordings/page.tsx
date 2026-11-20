import { HydrationBoundary } from "@tanstack/react-query";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readRecordingLibrary } from "@/lib/data/recording-library";
import { libraryKeys } from "@/lib/documents/query-keys";
import { parseLibraryQuery } from "@/lib/library/library-query";
import { seedLibraryPage } from "@/lib/library/library-seed";
import { getPersonalViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

export default async function ConsultantRecordingsRoute({
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
    name: "recordings:expert",
    queryKey: libraryKeys.personal("recordings", "consultant", consultantId),
    searchParams: await searchParams,
    // An inspecting operator's list is read by the route as the profile's owner.
    skip: access.isInspecting,
    read: () =>
      readRecordingLibrary({
        userId: access.userId,
        owner: { kind: "personal", side: "expert" },
        query: parseLibraryQuery(() => null),
      }),
  });
  return (
    <>
      <DashboardHeader
        title="Recordings"
        description="Recordings of the sessions you host, by booking. Open a booking to manage a recording."
      />
      <DashboardContent>
        <DisplayZoneProvider zone={viewerZone.zone}>
          <HydrationBoundary state={seed}>
            <PersonalLibrary
              tree="consultant"
              profileId={consultantId}
              artifact="recordings"
            />
          </HydrationBoundary>
        </DisplayZoneProvider>
      </DashboardContent>
    </>
  );
}
