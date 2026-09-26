import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AdminHomePageClient from "./AdminHomePageClient";
import { getAdminStats } from "@/lib/data/admin-stats";
import { redirect } from "next/navigation";
import { requireBackofficePage } from "@/lib/auth-guard";
import { backofficeLandingHref } from "@/lib/backoffice/capability";

export default async function AdminHomePage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  const { cap } = await requireBackofficePage(
    "users.read",
    (await params).tree,
  );
  // Q12 — the staff console opens on Tickets; Home is admin's.
  if (cap.tree === "staff") redirect(backofficeLandingHref(cap));
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the admin stats so the client useQuery hydrates
  // without a fetch waterfall. queryKey ["admin-stats"] MUST match the
  // client in AdminHomePageClient. allSettled so a read failure degrades to
  // a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["admin-stats"],
      queryFn: getAdminStats,
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AdminHomePageClient />
    </HydrationBoundary>
  );
}
