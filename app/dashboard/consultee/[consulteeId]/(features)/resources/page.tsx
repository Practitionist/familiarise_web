"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ResourcesTab } from "./ResourcesTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function ResourcesPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  const {
    data: resourcesData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["consultee-resources", consulteeId],
    queryFn: async () => {
      const res = await fetch(
        `/api/dashboard/consultee/${consulteeId}/resources`,
      );
      if (!res.ok) throw new Error("Failed to fetch resources");
      const json = await res.json();
      return json.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Resources</h3>
            <p className="text-sm">
              {error.message || "Failed to load resources. Please try again."}
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
      <ResourcesTab data={resourcesData} onRefresh={() => refetch()} />
    </DashboardErrorBoundary>
  );
}
