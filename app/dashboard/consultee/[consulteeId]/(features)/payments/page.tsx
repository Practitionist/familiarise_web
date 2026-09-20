import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readConsulteePayments } from "@/lib/data/consultee-payments";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { PaymentsTab } from "./PaymentsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

/**
 * /dashboard/consultee/[consulteeId]/payments — Needs you + History, Credits.
 *
 * #1675 X1 — this was the only money surface with no SSR seed. The page now
 * reads through the same `lib/data` function the API route answers with and
 * hydrates react-query, so the first paint carries the rows and the client
 * query only revalidates.
 */
export default async function PaymentsPage({ params }: Readonly<PageProps>) {
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
      <SeededPayments consulteeId={consulteeId} userId={profile.userId} />
    </Suspense>
  );
}

async function SeededPayments({
  consulteeId,
  userId,
}: Readonly<{
  consulteeId: string;
  userId: string;
}>) {
  const queryClient = new QueryClient();
  // The key MUST match PaymentsTab's useQuery key or hydration won't apply.
  // Personal pin (ADR 19): org-funded transactions belong to the org
  // dashboard's money views. prefetchQuery swallows a failed read, so the
  // client falls back to its own fetch and its error state.
  await queryClient.prefetchQuery({
    queryKey: ["consultee-payments", consulteeId, "personal"],
    queryFn: () =>
      readConsulteePayments({
        consulteeId,
        userId,
        orgScope: { kind: "personal" },
      }),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PaymentsTab consulteeId={consulteeId} />
    </HydrationBoundary>
  );
}
