"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarX2 } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import HomeTab from "./HomeTab";
import { useUser } from "../../UserContext";

export default function HomePageClient({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const { userDetails } = useUser();

  // Default to "All activity" so an org learner sees both personal AND
  // org-funded upcoming sessions on their landing page. Without this the
  // events fetcher defaulted to ?orgScope=personal and silently hid every
  // org-funded session on Home (visible only after navigating to
  // Appointments and toggling the filter). The /api/dashboard/consultee/
  // <id>/events route is self-scoped (consulteeProfileId match), so
  // `?orgScope=all` is safe — see lib/api/scope/parse.ts allowAllForOwner.
  const { scope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;

  const eventsQuery = {
    ...createConsulteeQueries(consulteeId, orgScopeParam).events,
    // Keep SSR-dehydrated events warm long enough to avoid an immediate
    // refetch waterfall on first paint (aligned with dashboard staleTimes).
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  };
  const { data: eventsData, isLoading, error, refetch } = useQuery(eventsQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !eventsData) {
    return <HomeSkeleton />;
  }

  if (error && !eventsData) {
    return (
      <EmptyState
        icon={CalendarX2}
        title="Couldn't load your sessions"
        description={
          (error as Error)?.message ||
          "Failed to load events data. Please try again."
        }
        action={<Button onClick={() => refetch()}>Retry</Button>}
      />
    );
  }

  if (!eventsData || !userDetails) {
    return <HomeSkeleton />;
  }

  return (
    <DashboardErrorBoundary>
      {/* Show subtle loading indicator when refreshing */}
      {isLoading && eventsData && (
        <div className="fixed top-4 right-4 bg-foreground text-background px-3 py-1 rounded-md text-sm z-50">
          Refreshing...
        </div>
      )}
      <HomeTab
        eventsData={eventsData}
        userDetails={{
          id: userDetails.id,
          name: userDetails.name ?? "User",
          email: userDetails.email ?? "",
          image: userDetails.image ?? undefined,
        }}
        isRefreshing={isLoading && !!eventsData}
        consulteeId={consulteeId}
      />
    </DashboardErrorBoundary>
  );
}
