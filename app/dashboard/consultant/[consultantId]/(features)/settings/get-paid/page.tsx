import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readConsultantPayoutSetup } from "@/lib/data/consultant-payout-setup";

import { GetPaidClient } from "../payouts/GetPaidClient";
import { payoutSetupQueryKey } from "../payouts/payout-setup-keys";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/settings/get-paid — Get paid (#1675
 * PR-Y2; a hub section since #1785 L-2, components unchanged under ../payouts).
 *
 * The bank/UPI account and the tax details a consultant has to give us before
 * a payout can reach them. Server component like the Earnings page: the guard
 * runs before the read, and the read is the same function the refetch route
 * answers with. The hub layout renders the header.
 */
export default async function GetPaidPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultant", consultantId);
  const queryClient = new QueryClient();

  // allSettled so a failed read degrades to a client-side fetch.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: payoutSetupQueryKey(consultantId),
      queryFn: () => readConsultantPayoutSetup(consultantId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <GetPaidClient consultantId={consultantId} />
    </HydrationBoundary>
  );
}
