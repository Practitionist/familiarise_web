import "server-only";

import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { recordingKeys } from "@/lib/documents/query-keys";
import {
  loadRecordingView,
  type RecordingViewerRole,
} from "@/lib/stream/recording-slots";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { RecordingSessions } from "./RecordingSessions";

/** Server half of every tree's Recording details page: resolve the viewer, prefetch, hydrate. */
export async function RecordingSessionsPage({
  appointmentId,
  userId,
  backHref,
  role,
  onNotParty,
}: Readonly<{
  appointmentId: string;
  userId: string;
  backHref: string;
  role: RecordingViewerRole | null;
  /** What to do for a caller who is neither host nor entitled learner. */
  onNotParty?: () => never;
}>) {
  const [view, viewerZone] = await Promise.all([
    loadRecordingView(appointmentId, userId),
    getViewerZone(),
  ]);
  if (!view || (role && view.viewerRole !== role)) {
    if (onNotParty) onNotParty();
    notFound();
  }
  const queryClient = new QueryClient();
  queryClient.setQueryData(recordingKeys.appointment(appointmentId), view);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DisplayZoneProvider zone={viewerZone.zone}>
        <RecordingSessions appointmentId={appointmentId} backHref={backHref} />
      </DisplayZoneProvider>
    </HydrationBoundary>
  );
}
