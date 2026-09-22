import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { PauseCircle } from "lucide-react";
import Link from "next/link";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  inboxQueryKey,
  readInboxParams,
} from "@/lib/dashboard/requests-inbox-state";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import prisma from "@/lib/prisma";
import { getViewerZone } from "@/lib/time/viewer-zone-server";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultant/[consultantId]/requests — the Requests inbox (#1775).
 *
 * A server component: the ownership guard runs before the read, the read
 * seeds react-query under the SAME key `RequestsInbox` queries, and the URL
 * (`?type=&chip=&sort=&page=`) is the state both sides render from — the
 * earnings/detail page idiom.
 */
export default async function RequestsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  const sp = await searchParams;
  const inbox = readInboxParams((key) => {
    const v = sp[key];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  });
  const queryArgs = {
    consultantProfileId: consultantId,
    scope: "personal",
    ...inbox,
  };

  const queryClient = new QueryClient();
  const [viewerZone, profile] = await Promise.all([
    getViewerZone(),
    prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { acceptingRequests: true },
    }),
  ]);
  // Swallow, don't rethrow: a read failure degrades to a client-side fetch.
  await queryClient
    .prefetchQuery({
      queryKey: inboxQueryKey(queryArgs),
      queryFn: () =>
        readRequestsInbox({
          consultantProfileId: consultantId,
          type: inbox.type,
          chip: inbox.chip ?? undefined,
          sort: inbox.sort,
          page: inbox.page,
        }),
    })
    .catch(() => undefined);

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Requests"
        subtitle="Everything waiting on an answer, a payment or a next cycle"
      />
      {profile?.acceptingRequests === false && (
        <Alert className="mt-6">
          <PauseCircle className="h-4 w-4" />
          <AlertDescription>
            You&apos;re not accepting new requests —{" "}
            <Link
              href={`/dashboard/consultant/${consultantId}/settings?tab=booking`}
              className="underline underline-offset-4"
            >
              turn it back on in Settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      <div className="pt-6">
        <HydrationBoundary state={dehydrate(queryClient)}>
          <RequestsInbox
            consultantProfileId={consultantId}
            viewerZone={viewerZone.zone}
          />
        </HydrationBoundary>
      </div>
    </DashboardErrorBoundary>
  );
}
