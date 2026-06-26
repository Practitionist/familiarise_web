"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { ConsulteeDashboardSkeleton } from "@/components/ui/dashboard-skeleton";
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
    // Show stale data immediately while fetching in background
    staleTime: 0,
    refetchOnWindowFocus: false,
  };
  const { data: eventsData, isLoading, error } = useQuery(eventsQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !eventsData) {
    return <ConsulteeDashboardSkeleton />;
  }

  if (error && !eventsData) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Events</h3>
            <p className="text-sm">
              {(error as Error)?.message ||
                "Failed to load events data. Please try again."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  if (!eventsData) {
    return <ConsulteeDashboardSkeleton />;
  }

  // If userDetails is not available, show skeleton
  if (!userDetails) {
    return <ConsulteeDashboardSkeleton />;
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
