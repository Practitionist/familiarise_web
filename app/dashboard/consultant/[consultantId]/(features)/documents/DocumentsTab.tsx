import * as Sentry from "@sentry/nextjs";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocumentsTabProps, IDocument } from "../../types";
import { useToast } from "@/hooks/use-toast";
import {
  Eye,
  Download,
  FileText,
  MessageSquare,
  Reply,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
} from "lucide-react";
import { ConsultantResponseUpload } from "./ConsultantResponseUpload";
import { DocumentReviewDrawer } from "@/components/documents/DocumentReviewDrawer";
import {
  groupDocumentsIntoThreads,
  type DocumentThread,
} from "@/lib/documents/document-review";
import {
  formatFileSize,
  getDocumentTypeIcon,
} from "@/lib/documents/document-utils";

const APPOINTMENT_TYPES = ["Consultation", "Subscription", "Trial"] as const;

const REVIEW_STATUSES = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
];

interface ExtendedDocumentsTabProps extends DocumentsTabProps {
  onRefresh?: () => void;
}

function buildConsultantDocumentColumns(
  threadsByRootId: Map<string, DocumentThread<IDocument>>,
  onView: (doc: IDocument) => void,
): ResponsiveColumn<IDocument>[] {
  return [
    {
      key: "document",
      header: "Deliverable / Document",
      primary: true,
      cell: (document) => {
        const thread = threadsByRootId.get(
          document.rootDocumentId ?? document.id,
        );
        const vCount = thread?.versionCount ?? 1;
        return (
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              {getDocumentTypeIcon(document.mimeType)}
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onView(document)}
                  className="truncate text-left text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {document.originalName}
                </button>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  v{document.versionNo ?? 1}
                </Badge>
                {vCount > 1 && (
                  <span className="text-[11px] text-muted-foreground">
                    ({vCount} in thread)
                  </span>
                )}
              </div>
              {document.reviewNotes && (
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  Feedback: {document.reviewNotes}
                </p>
              )}
              <div className="text-xs text-muted-foreground/70">
                {formatFileSize(document.fileSize)}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "client",
      header: "Learner",
      cell: (document) => (
        <div className="text-sm">
          <div className="font-medium text-foreground">
            {document.clientName}
          </div>
          <div className="text-xs text-muted-foreground">
            {document.invoiceNo}
          </div>
        </div>
      ),
    },
    {
      key: "appointment",
      header: "Appointment",
      cell: (document) => (
        <div className="text-sm">
          <div className="font-medium text-foreground">
            {document.appointmentTitle}
          </div>
          <div className="text-xs text-muted-foreground">
            {document.appointmentType?.toLowerCase()}
          </div>
        </div>
      ),
    },
    {
      key: "uploadDate",
      header: "Upload Date",
      cell: (document) => (
        <div>
          <div className="text-sm text-foreground">
            {format(new Date(document.uploadedAt), "MMM d, yyyy")}
          </div>
          <div className="text-xs text-muted-foreground">
            {format(new Date(document.uploadedAt), "h:mm a")}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (document) => (
        <div>
          <StatusBadge {...documentReviewStatusBadge(document.reviewStatus)} />
          {document.reviewedAt && (
            <div className="mt-1 text-xs text-muted-foreground">
              Reviewed {format(new Date(document.reviewedAt), "MMM d, yyyy")}
            </div>
          )}
        </div>
      ),
    },
  ];
}

export function DocumentsTab({
  documentsPage,
  isPlaceholderData,
  onRefresh,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  statusFilter,
  typeFilter,
  onStatusFilterChange,
  onTypeFilterChange,
}: Readonly<ExtendedDocumentsTabProps>) {
  const [selectedDocument, setSelectedDocument] = useState<IDocument | null>(
    null,
  );
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [responseDialogOpen, setResponseDialogOpen] = useState(false);
  const [documentForResponse, setDocumentForResponse] =
    useState<IDocument | null>(null);
  const [reviewStatus, setReviewStatus] = useState<string>("");
  const [reviewNotes, setReviewNotes] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [viewMode, setViewMode] = useState<"threaded" | "all">("threaded");
  const [drawerRootId, setDrawerRootId] = useState<string | null>(null);
  const [drawerInitialVersionId, setDrawerInitialVersionId] = useState<
    string | undefined
  >(undefined);
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  const [bulkReviewDialogOpen, setBulkReviewDialogOpen] = useState(false);
  const [bulkReviewStatus, setBulkReviewStatus] = useState<string>("");
  const [bulkReviewNotes, setBulkReviewNotes] = useState<string>("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const documents = useMemo(
    () => documentsPage?.data ?? [],
    [documentsPage?.data],
  );
  const pagination = documentsPage?.pagination;
  const totalCount = pagination?.totalCount ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const currentPage = pagination?.currentPage ?? page;
  const hasNextPage = pagination?.hasNextPage ?? false;
  const hasPrevPage = pagination?.hasPrevPage ?? false;

  const threadsByRootId = useMemo(() => {
    const map = new Map<string, DocumentThread<IDocument>>();
    for (const thread of groupDocumentsIntoThreads(documents)) {
      map.set(thread.rootId, thread);
    }
    return map;
  }, [documents]);

  const drawerThread = useMemo(
    () => (drawerRootId ? (threadsByRootId.get(drawerRootId) ?? null) : null),
    [drawerRootId, threadsByRootId],
  );

  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, pageSize]);

  const filteredDocuments = useMemo(() => {
    const baseDocs =
      viewMode === "threaded"
        ? Array.from(threadsByRootId.values()).map((t) => t.latestVersion)
        : documents;

    if (!debouncedSearch) return baseDocs;
    const query = debouncedSearch.toLowerCase();
    return baseDocs.filter((doc) => {
      return (
        doc.originalName.toLowerCase().includes(query) ||
        doc.clientName.toLowerCase().includes(query) ||
        doc.appointmentTitle.toLowerCase().includes(query) ||
        (doc.description?.toLowerCase().includes(query) ?? false) ||
        (doc.reviewNotes?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [documents, threadsByRootId, viewMode, debouncedSearch]);

  const showStart = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const showEnd = Math.min(currentPage * pageSize, totalCount);

  const hasActiveFilters =
    statusFilter !== "all" || typeFilter !== "all" || debouncedSearch !== "";

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    onStatusFilterChange("all");
    onTypeFilterChange("all");
  };

  const allOnPageSelected =
    filteredDocuments.length > 0 &&
    filteredDocuments.every((d) => selectedIds.has(d.id));

  const toggleSelectAll = () => {
    if (allOnPageSelected) {
      const next = new Set(selectedIds);
      filteredDocuments.forEach((d) => next.delete(d.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      filteredDocuments.forEach((d) => next.add(d.id));
      setSelectedIds(next);
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleBulkStatusUpdate = async (newStatus: string, notes?: string) => {
    if (selectedIds.size === 0) return;
    setIsBulkUpdating(true);

    try {
      const documentIds = Array.from(selectedIds);
      const res = await fetch("/api/documents/bulk-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentIds,
          reviewStatus: newStatus,
          reviewNotes: notes?.trim() || null,
        }),
      });

      if (!res.ok) throw new Error("Bulk review failed");

      const { data } = await res.json();
      const updated: number = data?.updated ?? 0;
      const failed = documentIds.length - updated;

      toast({
        title: "Bulk Review Complete",
        description: failed
          ? `${updated} updated, ${failed} not updated`
          : `${updated} document${updated !== 1 ? "s" : ""} updated to ${documentReviewStatusBadge(newStatus).label}`,
        variant: failed ? "destructive" : "default",
      });

      onRefresh?.();
      if (failed === 0) {
        setSelectedIds(new Set());
        setBulkReviewDialogOpen(false);
        setBulkReviewStatus("");
        setBulkReviewNotes("");
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Failed to update documents",
        variant: "destructive",
      });
    } finally {
      setIsBulkUpdating(false);
    }
  };

  const handleUploadResponse = (document: IDocument) => {
    setDocumentForResponse(document);
    setResponseDialogOpen(true);
  };

  const handleReviewClick = (document: IDocument) => {
    setSelectedDocument(document);
    setReviewStatus(document.reviewStatus);
    setReviewNotes(document.reviewNotes || "");
    setReviewDialogOpen(true);
  };

  const handleReviewSubmit = async () => {
    if (!selectedDocument) return;

    setIsUpdating(true);
    try {
      const response = await fetch(
        `/api/appointments/${selectedDocument.appointmentId}/documents/${selectedDocument.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reviewStatus,
            reviewNotes: reviewNotes.trim() || null,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update review");
      }

      toast({
        title: "Review Updated",
        description: `Document review status updated to ${documentReviewStatusBadge(reviewStatus).label}`,
      });

      setReviewDialogOpen(false);
      onRefresh?.();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to update review",
        variant: "destructive",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDownload = async (document: IDocument) => {
    try {
      const downloadUrl = `/api/appointments/${document.appointmentId}/documents/${document.id}/download`;
      const link = window.document.createElement("a");
      link.href = downloadUrl;
      link.download = document.originalName;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Failed to download file",
        variant: "destructive",
      });
    }
  };

  const handleView = useCallback(
    (document: IDocument) => {
      const rootId = document.rootDocumentId ?? document.id;
      if (threadsByRootId.has(rootId)) {
        setDrawerInitialVersionId(document.id);
        setDrawerRootId(rootId);
        return;
      }
      window.open(
        `/api/appointments/${document.appointmentId}/documents/${document.id}/download?disposition=inline`,
        "_blank",
      );
    },
    [threadsByRootId],
  );

  const columns = useMemo(
    () => buildConsultantDocumentColumns(threadsByRootId, handleView),
    [threadsByRootId, handleView],
  );

  const renderRowActions = (document: IDocument) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Document actions"
          className="h-8 w-8 cursor-pointer"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => handleView(document)}
        >
          <Eye className="mr-2 h-4 w-4" />
          Preview & Thread
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => void handleDownload(document)}
        >
          <Download className="mr-2 h-4 w-4" />
          Download
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => handleUploadResponse(document)}
        >
          <Reply className="mr-2 h-4 w-4" />
          Upload Response
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => handleReviewClick(document)}
        >
          <MessageSquare className="mr-2 h-4 w-4" />
          Quick Status
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const emptyState = hasActiveFilters ? (
    <div className="py-12 text-center text-muted-foreground">
      <Search className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
      <p className="text-lg font-medium text-foreground">
        No matching documents
      </p>
      {debouncedSearch && (
        <p className="mt-1 text-sm">
          No results for &quot;{debouncedSearch}&quot;
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={clearFilters}
      >
        Clear Filters
      </Button>
    </div>
  ) : (
    <div className="py-12 text-center text-muted-foreground">
      <FileText className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
      <p className="text-lg font-medium text-foreground">
        No documents for review
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm">
        When learners submit files for their consultations or subscriptions, you
        can review, approve, or request revisions from this tab.
      </p>
    </div>
  );

  return (
    <>
      <DashboardHeader
        title="Documents For Review"
        subtitle="Review deliverable threads and submissions across your sessions"
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
              <Button
                type="button"
                size="sm"
                variant={viewMode === "threaded" ? "default" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setViewMode("threaded")}
              >
                Threaded ({threadsByRootId.size})
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewMode === "all" ? "default" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setViewMode("all")}
              >
                All Uploads ({documents.length})
              </Button>
            </div>
            <Badge variant="secondary" className="text-sm">
              {totalCount}
            </Badge>
          </div>
        }
      />

      <div className="overflow-hidden bg-card p-4 text-card-foreground sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search documents by name, learner, or appointment"
              placeholder="Search by name, learner, or appointment..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={onStatusFilterChange}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {REVIEW_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {documentReviewStatusBadge(s).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={onTypeFilterChange}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {APPOINTMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger className="w-full sm:w-[120px]">
              <SelectValue placeholder="Page size" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 / page</SelectItem>
              <SelectItem value="25">25 / page</SelectItem>
              <SelectItem value="50">50 / page</SelectItem>
            </SelectContent>
          </Select>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear Filters
            </Button>
          )}
        </div>

        {totalCount > 0 && (
          <div className="mb-2 text-sm text-muted-foreground">
            Showing {showStart}-{showEnd} of {totalCount} document
            {totalCount !== 1 ? "s" : ""}
            {debouncedSearch &&
              filteredDocuments.length !== documents.length && (
                <>
                  {" "}
                  ({filteredDocuments.length} match
                  {filteredDocuments.length !== 1 ? "es" : ""} on this page)
                </>
              )}
          </div>
        )}

        {selectedIds.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <span className="text-sm font-medium text-foreground">
              {selectedIds.size} selected
            </span>
            <Button
              size="sm"
              onClick={() => setBulkReviewDialogOpen(true)}
              disabled={isBulkUpdating}
            >
              {isBulkUpdating ? "Updating..." : "Review Selected"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear Selection
            </Button>
          </div>
        )}

        <ResponsiveTable<IDocument>
          columns={columns}
          rows={filteredDocuments}
          getRowId={(d) => d.id}
          selectable
          selectedIds={selectedIds}
          onToggle={toggleSelect}
          onToggleAll={toggleSelectAll}
          allSelected={allOnPageSelected && filteredDocuments.length > 0}
          rowActions={renderRowActions}
          empty={emptyState}
        />

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page - 1)}
                disabled={!hasPrevPage || isPlaceholderData}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page + 1)}
                disabled={!hasNextPage || isPlaceholderData}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <ResponsiveModal
          open={reviewDialogOpen}
          onOpenChange={setReviewDialogOpen}
        >
          <ResponsiveModalContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-[425px]">
            <ResponsiveModalHeader className="shrink-0">
              <ResponsiveModalTitle>Review Document</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                Update the review status and add notes for{" "}
                {selectedDocument?.originalName}
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto py-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Review Status</p>
                <Select value={reviewStatus} onValueChange={setReviewStatus}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEW_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {documentReviewStatusBadge(s).label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="review-notes-textarea"
                  className="text-sm font-medium"
                >
                  Review Notes
                </label>
                <Textarea
                  id="review-notes-textarea"
                  placeholder="Add any comments or feedback..."
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  className="min-h-[100px]"
                />
              </div>
              {selectedDocument && (
                <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  <p>
                    <strong>Learner:</strong> {selectedDocument.clientName}
                  </p>
                  <p>
                    <strong>File:</strong> {selectedDocument.originalName}
                  </p>
                  <p>
                    <strong>Size:</strong>{" "}
                    {formatFileSize(selectedDocument.fileSize)}
                  </p>
                  {selectedDocument.description && (
                    <p>
                      <strong>Description:</strong>{" "}
                      {selectedDocument.description}
                    </p>
                  )}
                </div>
              )}
            </div>
            <ResponsiveModalFooter className="shrink-0">
              <Button
                variant="outline"
                onClick={() => setReviewDialogOpen(false)}
                disabled={isUpdating}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleReviewSubmit()}
                disabled={isUpdating || !reviewStatus}
              >
                {isUpdating ? "Updating..." : "Update Review"}
              </Button>
            </ResponsiveModalFooter>
          </ResponsiveModalContent>
        </ResponsiveModal>

        <ResponsiveModal
          open={bulkReviewDialogOpen}
          onOpenChange={(open) => {
            setBulkReviewDialogOpen(open);
            if (!open) {
              setBulkReviewStatus("");
              setBulkReviewNotes("");
            }
          }}
        >
          <ResponsiveModalContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-[500px]">
            <ResponsiveModalHeader className="shrink-0">
              <ResponsiveModalTitle>
                Review {selectedIds.size} Documents
              </ResponsiveModalTitle>
              <ResponsiveModalDescription>
                Set a review status and optional notes for all selected
                documents.
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto py-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Review Status</p>
                <Select
                  value={bulkReviewStatus}
                  onValueChange={setBulkReviewStatus}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEW_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {documentReviewStatusBadge(s).label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="bulk-review-notes-textarea"
                  className="text-sm font-medium"
                >
                  Shared Notes{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <Textarea
                  id="bulk-review-notes-textarea"
                  placeholder="Add notes that will apply to all selected documents..."
                  value={bulkReviewNotes}
                  onChange={(e) => setBulkReviewNotes(e.target.value)}
                  className="min-h-[100px]"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Selected Documents</p>
                <div className="max-h-[200px] space-y-2 overflow-y-auto rounded-md border p-2">
                  {documents
                    .filter((d) => selectedIds.has(d.id))
                    .map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between py-1 text-sm"
                      >
                        <span className="mr-2 truncate">
                          {doc.originalName}
                        </span>
                        <StatusBadge
                          {...documentReviewStatusBadge(doc.reviewStatus)}
                          size="sm"
                        />
                      </div>
                    ))}
                </div>
              </div>
            </div>
            <ResponsiveModalFooter className="shrink-0">
              <Button
                variant="outline"
                onClick={() => setBulkReviewDialogOpen(false)}
                disabled={isBulkUpdating}
              >
                Cancel
              </Button>
              <Button
                onClick={() =>
                  void handleBulkStatusUpdate(bulkReviewStatus, bulkReviewNotes)
                }
                disabled={isBulkUpdating || !bulkReviewStatus}
              >
                {isBulkUpdating ? "Updating..." : "Review All"}
              </Button>
            </ResponsiveModalFooter>
          </ResponsiveModalContent>
        </ResponsiveModal>

        {documentForResponse && (
          <ConsultantResponseUpload
            appointmentId={documentForResponse.appointmentId}
            responseToDocument={documentForResponse}
            isOpen={responseDialogOpen}
            onClose={() => {
              setResponseDialogOpen(false);
              setDocumentForResponse(null);
            }}
            onSuccess={onRefresh}
          />
        )}

        <DocumentReviewDrawer
          thread={drawerThread}
          isOpen={Boolean(drawerThread)}
          onClose={() => {
            setDrawerRootId(null);
            setDrawerInitialVersionId(undefined);
          }}
          viewerRole="consultant"
          canUpload
          initialVersionId={drawerInitialVersionId}
          onUpdated={onRefresh}
        />
      </div>
    </>
  );
}
