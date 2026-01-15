import React, { useState } from "react";
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
import { DocumentsTabProps, IDocument } from "../../types";
import { useToast } from "@/hooks/use-toast";
import { Eye, Download, FileText, MessageSquare } from "lucide-react";
import {
  formatFileSize,
  getStatusColor,
} from "@/app/dashboard/shared/utils/document-utils";

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
  const [reviewStatus, setReviewStatus] = useState<string>("");
  const [reviewNotes, setReviewNotes] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);
  const { toast } = useToast();


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
        description: `Document review status updated to ${reviewStatus.toLowerCase().replace("_", " ")}`,
      });

      setReviewDialogOpen(false);
      // Refresh the data using React Query instead of full page reload
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
      // Use our download API endpoint instead of direct Supabase URL
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
    // Open file in new tab for viewing
    window.open(document.fileUrl, "_blank");
  };

  return (
    <div className="bg-white p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Documents For Review</h2>
          <p className="text-sm text-gray-600 mt-1">
            Review documents submitted by your consultees and subscribers
          </p>
        </div>
        <div className="text-sm text-gray-500">
          {documents.length} document{documents.length !== 1 ? "s" : ""}
        </div>
      </div>

      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Appointment</TableHead>
              <TableHead>Upload Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((document) => (
              <TableRow key={document.id}>
                <TableCell>
                  <div className="flex items-center space-x-3">
                    <div className="flex-shrink-0">
                      <FileText className="h-5 w-5 text-gray-400" />
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
                <TableCell>
                  <div className="text-sm text-gray-900">
                    {new Date(document.uploadedAt).toLocaleDateString()}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(document.uploadedAt).toLocaleTimeString()}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={getStatusColor(document.reviewStatus)}
                  >
                    {document.reviewStatus.replace("_", " ")}
                  </Badge>
                  {document.reviewedAt && (
                    <div className="text-xs text-gray-500 mt-1">
                      Reviewed{" "}
                      {new Date(document.reviewedAt).toLocaleDateString()}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                      onClick={() => handleView(document)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-gray-50 hover:bg-gray-100"
                      onClick={() => handleDownload(document)}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => handleReviewClick(document)}
                    >
                      <MessageSquare className="h-4 w-4 mr-1" />
                      Review
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {documents.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-gray-500 py-12"
                >
                  <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-medium">No documents for review</p>
                  <p className="text-sm">
                    Documents uploaded by your consultees will appear here
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

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
    </div>
  );
}
