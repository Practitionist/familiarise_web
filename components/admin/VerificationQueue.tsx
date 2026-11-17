"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, RefreshCw, User, CheckCircle2 } from "lucide-react";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import {
  keepPreviousPageOnly,
  usePageWithinTotal,
} from "@/components/dashboard/shared/paged-list-filters";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  verificationQueuePageSchema,
  type VerificationItem,
  type VerificationQueuePage,
} from "@/lib/backoffice/people-list-schemas";
import { verificationStatus } from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { VerificationReviewModal } from "./VerificationReviewModal";

const PAGE_SIZE = 20;
const API = "/api/admin/verification";

async function fetchQueue(page: number): Promise<VerificationQueuePage> {
  const params = new URLSearchParams({
    status: "PENDING",
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  const res = await fetch(`${API}?${params}`);
  return readListBody(
    res,
    verificationQueuePageSchema,
    "Pending verifications could not load.",
  );
}

const initials = (name: string | null) =>
  (name || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

/** The expert verification queue, one server page at a time, oldest submission first. */
export function VerificationQueue() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const queryKey = ["verification-queue", "PENDING", page] as const;
  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } =
    useQuery({
      queryKey,
      queryFn: () => fetchQueue(page),
      placeholderData: keepPreviousPageOnly<VerificationQueuePage>(queryKey, 2),
    });
  // Deciding the last applicant on a page moves back a page; only this page's own answer counts.
  usePageWithinTotal(
    page,
    setPage,
    isPlaceholderData ? undefined : data?.pagination.total,
    PAGE_SIZE,
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // A failed load says so; an empty queue says it is empty.
  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <p role="alert" className="text-sm text-destructive">
            {error instanceof Error
              ? error.message
              : "Pending verifications could not load."}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { verifications, pagination } = data;
  if (pagination.total === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <CheckCircle2 className="mb-4 h-12 w-12 text-green-500" />
          <h3 className="text-lg font-semibold">All caught up</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            No pending verifications to review
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {pagination.total} pending verification
            {pagination.total === 1 ? "" : "s"}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        {verifications.map((verification) => {
          const consultant = verification.consultant;
          return (
            <Card
              key={verification.id}
              className="cursor-pointer transition-shadow hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700"
              onClick={() => setSelected(verification)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <PersonCell
                      person={{
                        id: consultant.userId,
                        name: consultant.name,
                        email: consultant.email,
                      }}
                      leading={
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={consultant.image || ""} />
                          <AvatarFallback>
                            {initials(consultant.name)}
                          </AvatarFallback>
                        </Avatar>
                      }
                    />
                    {consultant.domain && (
                      <Badge variant="outline" className="mt-2 text-xs">
                        {consultant.domain}
                      </Badge>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <StatusBadge {...verificationStatus(verification.status)} />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Submitted{" "}
                      <OperatorTime value={verification.submittedAt} />
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <User className="h-4 w-4" />
                    {consultant.experience
                      ? `${consultant.experience} yrs exp`
                      : "No exp listed"}
                  </span>
                  <span className="flex items-center gap-1">
                    <FileText className="h-4 w-4" />
                    {verification.documents.length} document
                    {verification.documents.length === 1 ? "" : "s"}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}

        <TablePagination
          page={pagination.page}
          pageSize={pagination.limit}
          total={pagination.total}
          onPageChange={setPage}
        />
      </div>

      <VerificationReviewModal
        verification={selected}
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onVerificationComplete={() => {
          setSelected(null);
          void refetch();
        }}
        apiBasePath={API}
      />
    </>
  );
}
