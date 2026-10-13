import "server-only";

import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { documentKeys } from "@/lib/documents/query-keys";
import type { DocumentPartyRole } from "@/lib/documents/document-party";
import { readDocumentWorkspace } from "@/lib/documents/workspace";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { DocumentsWorkspace } from "./DocumentsWorkspace";

/** Server half of every tree's Documents workspace: authorise as a party, prefetch, hydrate. */
export async function DocumentsWorkspacePage({
  appointmentId,
  userId,
  backHref,
  role,
}: Readonly<{
  appointmentId: string;
  userId: string;
  backHref: string;
  /** The side this dashboard tree is for; null accepts either (organisation tree). */
  role: DocumentPartyRole | null;
}>) {
  const [workspace, viewerZone] = await Promise.all([
    readDocumentWorkspace(appointmentId, userId),
    getViewerZone(),
  ]);
  if (!workspace) notFound();
  if (role && workspace.booking.viewerRole !== role) notFound();

  const queryClient = new QueryClient();
  queryClient.setQueryData(documentKeys.workspace(appointmentId), workspace);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DisplayZoneProvider zone={viewerZone.zone}>
        <DocumentsWorkspace appointmentId={appointmentId} backHref={backHref} />
      </DisplayZoneProvider>
    </HydrationBoundary>
  );
}
