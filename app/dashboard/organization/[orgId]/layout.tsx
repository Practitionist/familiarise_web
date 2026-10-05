import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import OrgDashboardShell from "./OrgDashboardShell";
import { getSession } from "@/lib/auth-server";
import { getOrgDetailsForSeed } from "@/lib/data/org-details-server";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import { toPlain } from "@/lib/data/serialize";

/**
 * Server shell that seeds the organization details query and enforces
 * server-side session and membership authorization before rendering the org
 * tree (falling back to client-side membership fetch only if the server seed
 * throws for an already-authenticated user).
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

  let seedErrored = false;
  const details = await getOrgDetailsForSeed(orgId).catch((err: unknown) => {
    seedErrored = true;
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "org-dashboard-seed" }, extra: { orgId } },
    );
    return null;
  });

  if (!details) {
    const session = await getSession(true);
    if (!session?.user?.id) {
      redirect("/auth/signin");
    }
    if (!seedErrored && session.user.role !== "ADMIN") {
      redirect("/dashboard");
    }
  }

  if (details) {
    await queryClient.prefetchQuery({
      queryKey: orgDetailsQueryKey(orgId),
      queryFn: async () => toPlain(details),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <OrgDashboardShell params={params}>{children}</OrgDashboardShell>
    </HydrationBoundary>
  );
}
