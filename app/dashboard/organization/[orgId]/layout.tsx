import { redirect } from "next/navigation";
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
 * tree.
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
  if (!details) {
    const session = await getSession(true);
    if (!session?.user?.id) {
      redirect("/auth/signin");
    }
    redirect("/dashboard");
  }

  await queryClient.prefetchQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: async () => toPlain(details),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <OrgDashboardShell params={params}>{children}</OrgDashboardShell>
    </HydrationBoundary>
  );
}
