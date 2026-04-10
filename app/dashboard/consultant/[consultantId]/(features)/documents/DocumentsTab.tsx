import React, { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  formatFileSize,
  getStatusColor,
  getStatusLabel,
  getDocumentTypeIcon,
} from "@/app/dashboard/shared/utils/document-utils";

// Appointment types are fixed on the server (Consultation | Subscription).
// Hardcoding here so the type filter dropdown isn't dependent on the current
// page's rows (which would give an incomplete list under pagination).
const APPOINTMENT_TYPES = ["Consultation", "Subscription"] as const;

interface ExtendedDocumentsTabProps extends DocumentsTabProps {
  onRefresh?: () => void;
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
  const { toast } = useToast();

  // Search is client-side (scoped to the current page). Status and type
  // filters are server-side and lifted to the parent page component so the
  // React Query key depends on them (issue #346).
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  // Debounce search input. Search is local to the current page, so we don't
  // need to reset server-side pagination on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Documents and pagination metadata come straight from the server envelope.
  const documents = documentsPage?.data ?? [];
  const pagination = documentsPage?.pagination;
  const totalCount = pagination?.totalCount ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const currentPage = pagination?.currentPage ?? page;
  const hasNextPage = pagination?.hasNextPage ?? false;
  const hasPrevPage = pagination?.hasPrevPage ?? false;

  // Clear bulk selection when the server page or page size changes — rows
  // that were selected are no longer visible, so acting on them would be
  // surprising. Matches the Gmail pattern for paginated bulk actions.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, pageSize]);

  // Client-side search filter only. Status and type filters are applied on
  // the server so pagination metadata stays accurate across all matching rows.
  const filteredDocuments = useMemo(() => {
    if (!debouncedSearch) return documents;
    const query = debouncedSearch.toLowerCase();
    return documents.filter((doc) => {
      return (
        doc.originalName.toLowerCase().includes(query) ||
        doc.clientName.toLowerCase().includes(query) ||
        doc.appointmentTitle.toLowerCase().includes(query) ||
        (doc.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [documents, debouncedSearch]);

  // "Showing X-Y of Z" values derive from the server pagination envelope so
  // they remain consistent across pages regardless of client-side search.
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

  // Bulk selection helpers. "On page" here means rows currently visible, i.e.
  // the server-paginated page intersected with the client-side search.
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

  const handleBulkStatusUpdate = async (newStatus: string) => {
    if (selectedIds.size === 0) return;
    setIsBulkUpdating(true);

    try {
      const selectedDocs = documents.filter((d) => selectedIds.has(d.id));
      const results = await Promise.allSettled(
        selectedDocs.map((doc) =>
          fetch(
            `/api/appointments/${doc.appointmentId}/documents/${doc.id}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reviewStatus: newStatus }),
            },
          ),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;

      toast({
        title: "Bulk Update Complete",
        description: failed
          ? `${succeeded} updated, ${failed} failed`
          : `${succeeded} document${succeeded !== 1 ? "s" : ""} updated to ${getStatusLabel(newStatus)}`,
        variant: failed ? "destructive" : "default",
      });

      setSelectedIds(new Set());
      onRefresh?.();
    } catch {
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
        description: `Document review status updated to ${getStatusLabel(reviewStatus)}`,
      });

      setReviewDialogOpen(false);
      onRefresh?.();
    } catch (error) {
      console.error("Error updating review:", error);
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
      console.error("Error downloading file:", error);
      toast({
        title: "Error",
        description: "Failed to download file",
        variant: "destructive",
      });
    }
  };

  const handleView = (document: IDocument) => {
    window.open(document.fileUrl, "_blank");
  };

  return (
    <div className="bg-white p-6 overflow-hidden">
      {/* Fix #2 + #5: h1 heading with badge count */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold whitespace-nowrap">Documents For Review</h1>
          <Badge variant="secondary" className="text-sm">
            {debouncedSearch && filteredDocuments.length !== documents.length
              ? `${filteredDocuments.length} / ${totalCount}`
              : totalCount}
          </Badge>
        </div>
        <p className="text-sm text-gray-600 mt-1">
          Review documents submitted by your consultees and subscribers
        </p>
      </div>

      {/* Fix #3: Search bar and filter dropdowns */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by name, client, or appointment..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="IN_REVIEW">In Review</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="NEEDS_REVISION">Needs Revision</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={onTypeFilterChange}>
          <SelectTrigger className="w-[160px]">
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
          <SelectTrigger className="w-[120px]">
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

      {/* Fix #3: Results count — driven by the server pagination envelope */}
      {totalCount > 0 && (
        <div className="text-sm text-gray-500 mb-2">
          Showing {showStart}-{showEnd} of {totalCount} document
          {totalCount !== 1 ? "s" : ""}
          {debouncedSearch && filteredDocuments.length !== documents.length && (
            <>
              {" "}
              ({filteredDocuments.length} match
              {filteredDocuments.length !== 1 ? "es" : ""} on this page)
            </>
          )}
        </div>
      )}

      {/* Fix #8: Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <span className="text-sm font-medium text-blue-800">
            {selectedIds.size} selected
          </span>
          <Select
            value=""
            onValueChange={handleBulkStatusUpdate}
            disabled={isBulkUpdating}
          >
            <SelectTrigger className="w-[180px] h-8">
              <SelectValue
                placeholder={
                  isBulkUpdating ? "Updating..." : "Set status..."
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="IN_REVIEW">In Review</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="NEEDS_REVISION">Needs Revision</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear Selection
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              {/* Fix #8: Checkbox column header */}
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected && filteredDocuments.length > 0}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all documents on this page"
                />
              </TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Appointment</TableHead>
              <TableHead>Upload Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredDocuments.map((document) => (
              <TableRow key={document.id}>
                {/* Fix #8: Checkbox column */}
                <TableCell>
                  <Checkbox
                    checked={selectedIds.has(document.id)}
                    onCheckedChange={() => toggleSelect(document.id)}
                    aria-label={`Select ${document.originalName}`}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center space-x-3">
                    {/* Fix #7: Document type icon */}
                    <div className="flex-shrink-0">
                      {getDocumentTypeIcon(document.mimeType)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {document.originalName}
                      </div>
                      {document.description && (
                        <div className="text-sm text-gray-500 truncate">
                          {document.description}
                        </div>
                      )}
                      <div className="text-xs text-gray-400">
                        {formatFileSize(document.fileSize)}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    <div className="font-medium">{document.clientName}</div>
                    <div className="text-gray-500 text-xs">
                      {document.invoiceNo}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    <div className="font-medium">
                      {document.appointmentTitle}
                    </div>
                    <div className="text-gray-500 text-xs">
                      {document.appointmentType?.toLowerCase()}
                    </div>
                  </div>
                </TableCell>
                {/* Fix #4: Formatted timestamps */}
                <TableCell>
                  <div className="text-sm text-gray-900">
                    {format(new Date(document.uploadedAt), "MMM d, yyyy")}
                  </div>
                  <div className="text-xs text-gray-500">
                    {format(new Date(document.uploadedAt), "h:mm a")}
                  </div>
                </TableCell>
                <TableCell>
                  {/* Fix #1: Proper status label */}
                  <Badge
                    variant="secondary"
                    className={getStatusColor(document.reviewStatus)}
                  >
                    {getStatusLabel(document.reviewStatus)}
                  </Badge>
                  {document.reviewedAt && (
                    <div className="text-xs text-gray-500 mt-1">
                      Reviewed{" "}
                      {format(new Date(document.reviewedAt), "MMM d, yyyy")}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 cursor-pointer">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="cursor-pointer" onClick={() => handleView(document)}>
                        <Eye className="h-4 w-4 mr-2" />
                        View
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => handleDownload(document)}>
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => handleUploadResponse(document)}>
                        <Reply className="h-4 w-4 mr-2" />
                        Upload Response
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => handleReviewClick(document)}>
                        <MessageSquare className="h-4 w-4 mr-2" />
                        Review
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {/* Fix #6: Enhanced empty states */}
            {filteredDocuments.length === 0 && hasActiveFilters && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-gray-500 py-12"
                >
                  <Search className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-medium">
                    No matching documents
                  </p>
                  {debouncedSearch && (
                    <p className="text-sm mt-1">
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
                </TableCell>
              </TableRow>
            )}
            {totalCount === 0 && !hasActiveFilters && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-gray-500 py-12"
                >
                  <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-medium">No documents for review</p>
                  <p className="text-sm mt-1 max-w-md mx-auto">
                    When clients submit files for their consultations or
                    subscriptions, you can review, approve, or request revisions
                    from this tab.
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination controls — driven by the server envelope (issue #346).
          Buttons are disabled while a placeholder page is visible so users
          can't fire off duplicate requests mid-transition. */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-gray-500">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={!hasPrevPage || isPlaceholderData}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={!hasNextPage || isPlaceholderData}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Review Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Review Document</DialogTitle>
            <DialogDescription>
              Update the review status and add notes for{" "}
              {selectedDocument?.originalName}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Review Status</label>
              <Select value={reviewStatus} onValueChange={setReviewStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="IN_REVIEW">In Review</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                  <SelectItem value="NEEDS_REVISION">Needs Revision</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Review Notes</label>
              <Textarea
                placeholder="Add any comments or feedback..."
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                className="min-h-[100px]"
              />
            </div>
            {selectedDocument && (
              <div className="text-sm text-gray-600 bg-gray-50 p-3 rounded">
                <p>
                  <strong>Client:</strong> {selectedDocument.clientName}
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
                    <strong>Description:</strong> {selectedDocument.description}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReviewDialogOpen(false)}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleReviewSubmit}
              disabled={isUpdating || !reviewStatus}
            >
              {isUpdating ? "Updating..." : "Update Review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Response Upload Dialog */}
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
    </div>
  );
}
