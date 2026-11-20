import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { PauseCircle } from "lucide-react";
import Link from "next/link";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  INBOX_DEFAULT_TYPE,
  inboxQueryKey,
  isInboxType,
  landingInboxType,
  readInboxParams,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { countRequestsToAnswerByTab } from "@/lib/data/needs-you";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import prisma from "@/lib/prisma";
import { getPersonalViewerZone } from "@/lib/time/viewer-zone-server";

import { AcceptingRequestsToggle } from "./AcceptingRequestsToggle";
import { DemandBanner } from "./DemandBanner";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /dashboard/consultant/[consultantId]/requests — the Requests inbox.
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
  const param = (key: string) => {
    const v = sp[key];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };

  const queryClient = new QueryClient();
  const [viewerZone, profile] = await Promise.all([
    getPersonalViewerZone("consultant", consultantId),
    prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { acceptingRequests: true },
    }),
  ]);
  // Swallow, don't rethrow: a read failure degrades to a client-side fetch.
  const seeded = new Set<InboxType>();
  const seed = async (type: InboxType) => {
    const inbox = readInboxParams(param, type);
    seeded.add(inbox.type);
    const queryKey = inboxQueryKey({
      consultantProfileId: consultantId,
      scope: "personal",
      ...inbox,
    });
    await queryClient
      .prefetchQuery({
        queryKey,
        queryFn: () =>
          readRequestsInbox({
            consultantProfileId: consultantId,
            type: inbox.type,
            chip: inbox.chip ?? undefined,
            sort: inbox.sort,
            page: inbox.page,
            after: inbox.after,
            focusId: inbox.focus,
          }),
      })
      .catch(() => undefined);
    return queryClient.getQueryData<RequestsInboxPayload>(queryKey);
  };
  // A link without `type` (Home's Review, the sidebar badge) opens the tab holding the rows it counted.
  let landingType = INBOX_DEFAULT_TYPE;
  if (!isInboxType(param("type"))) {
    const toAnswer = await countRequestsToAnswerByTab({
      consultantProfileId: consultantId,
    }).catch(() => ({ consultation: 0, subscription: 0 }));
    landingType = landingInboxType(toAnswer);
    if (toAnswer.consultation + toAnswer.subscription === 0) {
      const first = await seed(INBOX_DEFAULT_TYPE);
      landingType = landingInboxType(toAnswer, first?.meta.counts);
    }
  }
  if (!seeded.has(landingType)) await seed(landingType);

  return (
    <>
      <DashboardHeader
        title="Booking requests"
        subtitle="Everything waiting on an answer, a payment or a next cycle"
        actions={<AcceptingRequestsToggle consultantId={consultantId} />}
      />
      {profile?.acceptingRequests === false && (
        <Alert className="mt-6">
          <PauseCircle className="h-4 w-4" />
          <AlertDescription>
            You&apos;ve paused new 1:1 bookings and trials. Webinars and classes
            keep selling. Turn &quot;Taking new 1:1 bookings and trials&quot;
            back on above, or review your{" "}
            <Link
              href={`/dashboard/consultant/${consultantId}/settings/booking`}
              className="underline underline-offset-4"
            >
              booking settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      {profile?.acceptingRequests !== false && (
        <div className="mt-6 empty:hidden">
          <DemandBanner consultantId={consultantId} />
        </div>
      )}
      <div className="pt-6">
        <HydrationBoundary state={dehydrate(queryClient)}>
          <RequestsInbox
            consultantProfileId={consultantId}
            viewerZone={viewerZone.zone}
            landingType={landingType}
          />
        </HydrationBoundary>
      </div>
    </>
  );
}
