"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { TableSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  fetchDocuments,
  type DocumentFetchError,
} from "../../utils/fetchHelpers";
import { DocumentsTab } from "./DocumentsTab";
import {
  RefreshCw,
  WifiOff,
  Database,
  ShieldX,
  HelpCircle,
  AlertCircle,
} from "lucide-react";

const DEFAULT_PAGE_SIZE = 10;

export default function DocumentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);
  const router = useRouter();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [uploadedByRole, setUploadedByRole] = useState<
    "CONSULTEE" | "CONSULTANT"
  >("CONSULTEE");

  const apiStatus = statusFilter === "all" ? undefined : statusFilter;
  const apiType = typeFilter === "all" ? undefined : typeFilter;
  const offset = (page - 1) * pageSize;

  const {
    data: documentsPage,
    isLoading,
    error,
    refetch,
    isRefetching,
    isPlaceholderData,
  } = useQuery({
    queryKey: [
      "documents",
      consultantId,
      {
        page,
        pageSize,
        status: apiStatus,
        type: apiType,
        uploadedByRole,
      },
    ],
    queryFn: () =>
      fetchDocuments(consultantId, {
        limit: pageSize,
        offset,
        status: apiStatus,
        appointmentType: apiType,
        uploadedByRole,
      }),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount, err) => {
      if (
        err instanceof Error &&
        (err.message.includes("sign in") ||
          err.message.includes("permission") ||
          err.message.includes("Access denied"))
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });

  const getErrorIcon = (err: Error) => {
    if (err.message.includes("connection") || err.message.includes("Network")) {
      return <WifiOff className="h-5 w-5" />;
    }
    if (
      err.message.includes("temporarily unavailable") ||
      err.message.includes("Database")
    ) {
      return <Database className="h-5 w-5" />;
    }
    if (
      err.message.includes("permission") ||
      err.message.includes("Access denied")
    ) {
      return <ShieldX className="h-5 w-5" />;
    }
    if (err.message.includes("not found")) {
      return <HelpCircle className="h-5 w-5" />;
    }
    return <AlertCircle className="h-5 w-5" />;
  };

  const getErrorActions = (err: Error) => {
    const actions = [];
    if (
      !err.message.includes("permission") &&
      !err.message.includes("Access denied")
    ) {
      actions.push(
        <Button
          key="retry"
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw
            className={`mr-1 h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
          />
          {isRefetching ? "Retrying..." : "Try Again"}
        </Button>,
      );
    }

    if (err.message.includes("sign in")) {
      actions.push(
        <Button
          key="signin"
          size="sm"
          onClick={() => router.push("/auth/signin")}
        >
          Sign In
        </Button>,
      );
    }

    return actions;
  };

  if (isLoading) {
    return <TableSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="w-full max-w-lg">
            <Alert variant="destructive" className="mb-4">
              <div className="flex items-start space-x-2">
                {getErrorIcon(error)}
                <div className="flex-1">
                  <AlertTitle className="mb-2 text-base font-semibold">
                    Unable to Load Documents
                  </AlertTitle>
                  <AlertDescription className="mb-4 text-sm">
                    {error.message}
                  </AlertDescription>

                  {process.env.NODE_ENV === "development" &&
                    (error as DocumentFetchError).technicalMessage && (
                      <details className="mt-3 text-xs opacity-75">
                        <summary className="cursor-pointer">
                          Technical Details
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap">
                          {(error as DocumentFetchError).technicalMessage}
                        </pre>
                      </details>
                    )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {getErrorActions(error)}
                  </div>
                </div>
              </div>
            </Alert>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <div className="min-w-0 overflow-x-hidden">
        <DocumentsTab
          consultantId={consultantId}
          documentsPage={documentsPage}
          isPlaceholderData={isPlaceholderData}
          onRefresh={refetch}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          statusFilter={statusFilter}
          typeFilter={typeFilter}
          onStatusFilterChange={(next) => {
            setStatusFilter(next);
            setPage(1);
          }}
          onTypeFilterChange={(next) => {
            setTypeFilter(next);
            setPage(1);
          }}
          uploadedByRole={uploadedByRole}
          onUploadedByRoleChange={(next) => {
            setUploadedByRole(next);
            setStatusFilter("all");
            setPage(1);
          }}
        />
      </div>
    </DashboardErrorBoundary>
  );
}
