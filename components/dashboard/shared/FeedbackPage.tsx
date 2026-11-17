"use client";

import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FilterBar } from "@/components/dashboard/FilterBar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MessageSquare,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  RefreshCw,
  Star,
  Loader2,
  Eye,
  Mail,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PlatformFeedbackStatus } from "@prisma/client";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  feedbackPageSchema,
  type FeedbackCounts,
  type PlatformFeedback,
} from "@/lib/backoffice/people-list-schemas";
import { feedbackStatus } from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";

const PAGE_SIZE = 20;

const EMPTY_COUNTS: FeedbackCounts = {
  total: 0,
  pending: 0,
  acknowledged: 0,
  inProgress: 0,
  resolved: 0,
  closed: 0,
};

const STATUS_OPTIONS: {
  value: PlatformFeedbackStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "All Status" },
  { value: "PENDING", label: "Pending" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

const getStatusIcon = (status: PlatformFeedbackStatus) => {
  switch (status) {
    case "PENDING":
      return <AlertCircle className="h-4 w-4 text-amber-500" />;
    case "ACKNOWLEDGED":
      return <Eye className="h-4 w-4 text-blue-500" />;
    case "IN_PROGRESS":
      return <Clock className="h-4 w-4 text-purple-500" />;
    case "RESOLVED":
    case "CLOSED":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
  }
};

export interface FeedbackPageProps {
  /** API endpoint for fetching/updating feedback (e.g. "/api/staff/feedbacks") */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
}

export function FeedbackPage({
  apiEndpoint = "/api/staff/feedbacks",
  title = "User Feedback",
  description = "Manage and respond to user feedback across the platform",
}: FeedbackPageProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  // Detail view state
  const [selectedFeedback, setSelectedFeedback] =
    useState<PlatformFeedback | null>(null);

  const [searchQuery, setSearchQuery] = useState("");

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["admin-feedbacks", apiEndpoint, page, statusFilter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: String(PAGE_SIZE),
        ...(statusFilter !== "all" && { status: statusFilter }),
        ...(searchQuery && { search: searchQuery }),
      });

      const response = await fetch(`${apiEndpoint}?${params}`);
      return readListBody(
        response,
        feedbackPageSchema,
        "Failed to fetch feedbacks",
      );
    },
    placeholderData: keepPreviousData,
  });

  const feedbacks = data?.feedbacks ?? [];
  const counts = data?.counts ?? EMPTY_COUNTS;

  const updateStatus = useMutation({
    mutationFn: async ({
      feedbackId,
      newStatus,
    }: {
      feedbackId: string;
      newStatus: PlatformFeedbackStatus;
    }) => {
      const response = await fetch(`${apiEndpoint}/${feedbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) throw new Error("Failed to update status");
      return { feedbackId, newStatus };
    },
    onSuccess: ({ feedbackId, newStatus }) => {
      toast({ title: "Success", description: "Status updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["admin-feedbacks"] });
      // Keep the open detail modal in sync without waiting for the refetch.
      setSelectedFeedback((current) =>
        current?.id === feedbackId
          ? { ...current, status: newStatus }
          : current,
      );
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      });
    },
  });

  const handleUpdateStatus = (
    feedbackId: string,
    newStatus: PlatformFeedbackStatus,
  ) => updateStatus.mutate({ feedbackId, newStatus });

  const renderRowActions = (feedback: PlatformFeedback) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            setSelectedFeedback(feedback);
          }}
        >
          View Details
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "ACKNOWLEDGED");
          }}
        >
          Mark Acknowledged
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "RESOLVED");
          }}
        >
          Mark Resolved
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "CLOSED");
          }}
        >
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const columns: ResponsiveColumn<PlatformFeedback>[] = [
    {
      key: "id",
      header: "ID",
      className: "font-mono text-xs text-muted-foreground",
      headClassName: "w-24",
      cell: (feedback) => feedback.id.slice(0, 8).toUpperCase(),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (feedback) => (
        <div className="flex items-center gap-2">
          {getStatusIcon(feedback.status)}
          <span className="font-medium truncate max-w-[200px]">
            {feedback.title}
          </span>
        </div>
      ),
    },
    {
      key: "user",
      header: "User",
      cell: (feedback) => (
        <PersonCell
          person={feedback.user}
          leading={
            <Avatar className="h-7 w-7">
              <AvatarImage src={feedback.user.image || ""} />
              <AvatarFallback className="text-xs">
                {feedback.user.name?.charAt(0) || "U"}
              </AvatarFallback>
            </Avatar>
          }
        />
      ),
    },
    {
      key: "rating",
      header: "Rating",
      cell: (feedback) =>
        feedback.rating ? (
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={`h-3.5 w-3.5 ${
                  i < feedback.rating!
                    ? "text-amber-500 fill-amber-500"
                    : "text-muted-foreground/40"
                }`}
              />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/70 text-sm">-</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (feedback) => <StatusBadge {...feedbackStatus(feedback.status)} />,
    },
    {
      key: "submitted",
      header: "Submitted",
      className: "text-muted-foreground text-sm",
      cell: (feedback) => <OperatorTime value={feedback.createdAt} />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title={title}
        subtitle={description}
        actions={
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Pending
                </p>
                <p className="text-2xl font-bold text-amber-600">
                  {counts.pending}
                </p>
              </div>
              <AlertCircle className="h-8 w-8 text-amber-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Acknowledged
                </p>
                <p className="text-2xl font-bold text-blue-600">
                  {counts.acknowledged}
                </p>
              </div>
              <Eye className="h-8 w-8 text-blue-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  In Progress
                </p>
                <p className="text-2xl font-bold text-purple-600">
                  {counts.inProgress}
                </p>
              </div>
              <Clock className="h-8 w-8 text-purple-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Resolved
                </p>
                <p className="text-2xl font-bold text-green-600">
                  {counts.resolved}
                </p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {counts.total}
                </p>
              </div>
              <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          <FilterBar
            search={{
              label: "Search feedback",
              placeholder: "Search by title, description, or user...",
              value: searchQuery,
              onChange: (value) => {
                setSearchQuery(value);
                setPage(1);
              },
            }}
            selects={[
              {
                key: "status",
                label: "Filter by status",
                value: statusFilter,
                options: STATUS_OPTIONS,
                onChange: (v) => {
                  setStatusFilter(v);
                  setPage(1);
                },
              },
            ]}
            canClear={Boolean(searchQuery) || statusFilter !== "all"}
            onClear={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setPage(1);
            }}
          />
        </CardContent>
      </Card>

      {/* Feedback Table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0 sm:p-6">
          {isError && !data ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span>Failed to load feedback.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : isPending ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : (
            <ResponsiveTable<PlatformFeedback>
              columns={columns}
              rows={feedbacks}
              getRowId={(f) => f.id}
              onRowClick={(f) => setSelectedFeedback(f)}
              rowActions={renderRowActions}
              empty={
                <div className="text-center py-12">
                  <MessageSquare className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground">No feedback found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      <TablePagination
        page={data?.pagination.page ?? page}
        pageSize={data?.pagination.limit ?? PAGE_SIZE}
        total={data?.pagination.total ?? 0}
        onPageChange={setPage}
      />

      {/* Detail Dialog */}
      <ResponsiveModal
        open={!!selectedFeedback}
        onOpenChange={(open) => !open && setSelectedFeedback(null)}
      >
        <ResponsiveModalContent className="sm:max-w-lg">
          {selectedFeedback && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  {getStatusIcon(selectedFeedback.status)}
                  {selectedFeedback.title}
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Submitted <OperatorTime value={selectedFeedback.createdAt} />
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>

              <div className="space-y-4">
                {/* User Info */}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                  <Avatar>
                    <AvatarImage src={selectedFeedback.user.image || ""} />
                    <AvatarFallback>
                      {selectedFeedback.user.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium">
                      {selectedFeedback.user.name || "Unknown"}
                    </p>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      {selectedFeedback.user.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {selectedFeedback.user.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Rating */}
                {selectedFeedback.rating && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Rating
                    </p>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-5 w-5 ${
                            i < selectedFeedback.rating!
                              ? "text-amber-500 fill-amber-500"
                              : "text-muted-foreground/40"
                          }`}
                        />
                      ))}
                      <span className="ml-2 text-sm text-muted-foreground">
                        {selectedFeedback.rating} / 5
                      </span>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Description
                  </p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">
                    {selectedFeedback.description}
                  </p>
                </div>

                {/* Status Update */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                    Update Status
                  </p>
                  <Select
                    value={selectedFeedback.status}
                    onValueChange={(value) =>
                      handleUpdateStatus(
                        selectedFeedback.id,
                        value as PlatformFeedbackStatus,
                      )
                    }
                    disabled={updateStatus.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
                      <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                      <SelectItem value="RESOLVED">Resolved</SelectItem>
                      <SelectItem value="CLOSED">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
