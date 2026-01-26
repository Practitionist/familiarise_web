"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HelpSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { staticQueries } from "@/hooks/useCosultantPrefetchDashboard";
import { HelpTab } from "./HelpTab";

export default function HelpPage() {
  // Use the centralized static query configuration
  const { data: faqData, isLoading, error } = useQuery(staticQueries.help);

  if (isLoading) {
    return <HelpSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Help Content</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load help content. Please try again."}
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
      <HelpTab faqs={faqData || []} />
    </DashboardErrorBoundary>
  );
}
