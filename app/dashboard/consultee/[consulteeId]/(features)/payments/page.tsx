"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { PaymentsTab } from "./PaymentsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function PaymentsPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  const {
    data: paymentsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["consultee-payments", consulteeId],
    queryFn: async () => {
      const res = await fetch(
        `/api/dashboard/consultee/${consulteeId}/payments`,
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
