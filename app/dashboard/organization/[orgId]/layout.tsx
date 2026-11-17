import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import OrgDashboardShell from "./OrgDashboardShell";
import { getOrgDetailsForSeed } from "@/lib/data/org-details-server";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import { toPlain } from "@/lib/data/serialize";
import { ViewerZone } from "@/app/support/_components/ViewerZone";

/**
 * Server shell that seeds the organization details query. A missing org or a
 * non-member 404s here, above this segment's loading.tsx, so the status is real.
 */
export default async function OrgDashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // A seed that throws renders the error boundary, never the shell.
  const details = await getOrgDetailsForSeed(orgId);
  if (!details) notFound();

  await queryClient.prefetchQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: async () => toPlain(details),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ViewerZone>
        <OrgDashboardShell params={params}>{children}</OrgDashboardShell>
      </ViewerZone>
    </HydrationBoundary>
  );
}
