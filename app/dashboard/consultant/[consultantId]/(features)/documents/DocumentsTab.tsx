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

const PAGE_LIMIT = 10;

interface ExtendedDocumentsTabProps extends DocumentsTabProps {
  onRefresh?: () => void;
}

export function DocumentsTab({
  documents,
  onRefresh,
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

  // Search, filter, and pagination state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, typeFilter]);

  // Client-side filtering
  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      // Status filter
      if (statusFilter !== "all" && doc.reviewStatus !== statusFilter) {
        return false;
      }
      // Type filter
      if (typeFilter !== "all" && doc.appointmentType !== typeFilter) {
        return false;
      }
      // Search filter
      if (debouncedSearch) {
        const query = debouncedSearch.toLowerCase();
        return (
          doc.originalName.toLowerCase().includes(query) ||
          doc.clientName.toLowerCase().includes(query) ||
          doc.appointmentTitle.toLowerCase().includes(query) ||
          (doc.description?.toLowerCase().includes(query) ?? false)
        );
      }
      return true;
    });
  }, [documents, statusFilter, typeFilter, debouncedSearch]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredDocuments.length / PAGE_LIMIT));
  const paginatedDocuments = useMemo(() => {
    const start = (page - 1) * PAGE_LIMIT;
    return filteredDocuments.slice(start, start + PAGE_LIMIT);
  }, [filteredDocuments, page]);

  const showStart = filteredDocuments.length === 0 ? 0 : (page - 1) * PAGE_LIMIT + 1;
  const showEnd = Math.min(page * PAGE_LIMIT, filteredDocuments.length);

  // Unique appointment types for type filter
  const appointmentTypes = useMemo(() => {
    const types = new Set(documents.map((d) => d.appointmentType));
    return Array.from(types).sort();
  }, [documents]);

  const hasActiveFilters =
    statusFilter !== "all" || typeFilter !== "all" || debouncedSearch !== "";

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setPage(1);
  };

  // Bulk selection helpers
  const allOnPageSelected =
    paginatedDocuments.length > 0 &&
    paginatedDocuments.every((d) => selectedIds.has(d.id));

  const toggleSelectAll = () => {
    if (allOnPageSelected) {
      const next = new Set(selectedIds);
      paginatedDocuments.forEach((d) => next.delete(d.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      paginatedDocuments.forEach((d) => next.add(d.id));
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
            {filteredDocuments.length !== documents.length
              ? `${filteredDocuments.length} / ${documents.length}`
              : documents.length}
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
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
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {appointmentTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.charAt(0) + type.slice(1).toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear Filters
          </Button>
        )}
      </div>

      {/* Fix #3: Results count */}
      {filteredDocuments.length > 0 && (
        <div className="text-sm text-gray-500 mb-2">
          Showing {showStart}-{showEnd} of {filteredDocuments.length} document
          {filteredDocuments.length !== 1 ? "s" : ""}
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
                  checked={allOnPageSelected && paginatedDocuments.length > 0}
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
            {paginatedDocuments.map((document) => (
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
            {paginatedDocuments.length === 0 && hasActiveFilters && (
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
            {documents.length === 0 && (
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

      {/* Fix #3: Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
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
