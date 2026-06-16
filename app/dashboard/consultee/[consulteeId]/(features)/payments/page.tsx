"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { useOrgScope } from "@/hooks/useOrgScope";
import { PaymentsTab } from "./PaymentsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function PaymentsPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  // Default to "All activity" so an org learner sees both personal AND
  // org-funded payments in one history view. Without this the events
  // route defaulted to ?orgScope=personal and silently hid every
  // org-funded transaction — same fix pattern as Home + Appointments.
  // The /api/dashboard/consultee/<id>/payments route has
  // allowAllForOwner: true, so ?orgScope=all is safe.
  const { scope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;

  const {
    data: paymentsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["consultee-payments", consulteeId, orgScopeParam] as const,
    queryFn: async () => {
      const qs =
        orgScopeParam && orgScopeParam !== "personal"
          ? `?orgScope=${encodeURIComponent(orgScopeParam)}`
          : "";
      const res = await fetch(
        `/api/dashboard/consultee/${consulteeId}/payments${qs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch payments");
      const json = await res.json();
      return json.data;
    },
    staleTime: 2 * 60 * 1000,
  });

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Payments</h3>
            <p className="text-sm">
              {error.message || "Failed to load payments. Please try again."}
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

  return (
    <DashboardErrorBoundary>
      <PaymentsTab data={paymentsData} />
    </DashboardErrorBoundary>
  );
}
