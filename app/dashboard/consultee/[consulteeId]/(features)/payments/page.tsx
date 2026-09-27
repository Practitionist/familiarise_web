import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  readConsulteePayments,
  type PaymentHistoryFilter,
  type PaymentHistoryRange,
} from "@/lib/data/consultee-payments";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { PaymentsTab } from "./PaymentsTab";
import { consulteePaymentsKey } from "./payments-query";

type SearchParams = Record<string, string | string[] | undefined>;

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<SearchParams>;
};

/**
 * /dashboard/consultee/[consulteeId]/payments — Needs you · History · Credits.
 *
 * #1675 X1 — this was the only money surface with no SSR seed. The page now
 * reads through the same `lib/data` function the API route answers with and
 * hydrates react-query, so the first paint carries the rows and the client
 * query only revalidates. #1527 — the seeded page is the one the URL names.
 */
export default async function PaymentsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consulteeId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);
  const profile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });
  if (!profile) notFound();

  return (
    <Suspense fallback={<PageSkeleton />}>
      <SeededPayments
        consulteeId={consulteeId}
        userId={profile.userId}
        searchParams={await searchParams}
      />
    </Suspense>
  );
}

async function SeededPayments({
  consulteeId,
  userId,
  searchParams,
}: Readonly<{
  consulteeId: string;
  userId: string;
  searchParams: SearchParams;
}>) {
  const first = (key: string) => {
    const value = searchParams[key];
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
  // The same parse the client's useListParams runs (hooks/useListParams is a
  // client module, so it cannot be called here), so the keys match.
  const rawPage = Number.parseInt(first("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const status = first("status") || null;
  const range = first("range") || null;
  const queryClient = new QueryClient();
  // Personal pin (ADR 19): org-funded transactions belong to the org
  // dashboard's money views. prefetchQuery swallows a failed read, so the
  // client falls back to its own fetch and its error state.
  await queryClient.prefetchQuery({
    queryKey: consulteePaymentsKey(consulteeId, page, status, range),
    queryFn: () =>
      readConsulteePayments({
        consulteeId,
        userId,
        orgScope: { kind: "personal" },
        query: {
          page,
          status: status as PaymentHistoryFilter | null,
          range: range as PaymentHistoryRange | null,
        },
      }),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PaymentsTab consulteeId={consulteeId} />
    </HydrationBoundary>
  );
}
