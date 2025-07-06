"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { useDocuments } from "../../hooks/useDocuments";
import { DocumentsTab } from "./DocumentsTab";

export default function DocumentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);
  const { data: documents, isLoading, error } = useDocuments(consultantId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Documents</h3>
            <p className="text-sm">
              {error.message || "Failed to load documents. Please try again."}
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
      <DocumentsTab documents={documents || []} />
    </DashboardErrorBoundary>
  );
}
