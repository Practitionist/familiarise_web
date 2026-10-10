"use client";

import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileText,
  FileUp,
  Loader2,
  MessageSquare,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import {
  ALLOWED_DOCUMENT_ACCEPT_ATTR,
  groupDocumentsIntoThreads,
  type DocumentThread,
  type ThreadableDocument,
} from "@/lib/documents/document-review";
import { getAppointmentDocumentUrl } from "@/lib/documents/urls";
import { formatFileSize } from "@/lib/documents/document-utils";
import { DocumentReviewDrawer } from "./DocumentReviewDrawer";

interface DeliverableThreadListProps {
  appointmentId: string;
  viewerRole: "consultee" | "consultant";
  canUpload?: boolean;
}

async function fetchAppointmentDocuments(
  appointmentId: string,
): Promise<ThreadableDocument[]> {
  const res = await fetch(`/api/appointments/${appointmentId}/documents`);
  if (!res.ok) {
    throw new Error(`Failed to fetch documents (${res.status})`);
  }
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

export function DeliverableThreadList({
  appointmentId,
  viewerRole,
  canUpload = false,
}: Readonly<DeliverableThreadListProps>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set());
  const [drawerThread, setDrawerThread] =
    useState<DocumentThread<ThreadableDocument> | null>(null);
  const [drawerInitialVersionId, setDrawerInitialVersionId] = useState<
    string | undefined
  >(undefined);

  const [showNewUploadForm, setShowNewUploadForm] = useState(false);
  const [newFile, setNewFile] = useState<File | null>(null);
  const [newDescription, setNewDescription] = useState("");
  const [isUploadingNew, setIsUploadingNew] = useState(false);

  const {
    data: documents = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["appointment-documents", appointmentId],
    queryFn: () => fetchAppointmentDocuments(appointmentId),
  });

  const threads = useMemo(
    () => groupDocumentsIntoThreads(documents),
    [documents],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["appointment-documents", appointmentId],
    });
  };

  const toggleTimeline = (rootId: string) => {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const handleCreateRootDocument = async () => {
    if (!newFile) return;
    setIsUploadingNew(true);
    try {
      const formData = new FormData();
      formData.append("file", newFile);
      if (newDescription.trim()) {
        formData.append("description", newDescription.trim());
      }

      const endpoint =
        viewerRole === "consultant"
          ? `/api/appointments/${appointmentId}/documents/consultant`
          : `/api/appointments/${appointmentId}/documents`;

      const res = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || body?.error || "Upload failed");
      }

      toast({
        title: "Document uploaded",
        description: `${newFile.name} has been added to this session.`,
      });
      setNewFile(null);
      setNewDescription("");
      setShowNewUploadForm(false);
      refresh();
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Upload failed",
        variant: "destructive",
      });
    } finally {
      setIsUploadingNew(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading session documents...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <span>Unable to load session documents right now.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {threads.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {viewerRole === "consultee"
            ? "No deliverables uploaded yet. Upload your resume, deck, or draft for review."
            : "No documents shared on this session yet."}
        </p>
      ) : (
        <div className="space-y-2.5">
          {threads.map((thread) => {
            const isExpanded = expandedRoots.has(thread.rootId);
            const needsRevision = thread.effectiveStatus === "NEEDS_REVISION";

            return (
              <div
                key={thread.rootId}
                className="rounded-lg border bg-card p-3 transition-colors hover:border-border/80"
              >
                {/* Top Header Row */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </span>
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px]"
                        >
                          v
                          {thread.latestVersion.versionNo ??
                            thread.versionCount}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Updated{" "}
                        {format(new Date(thread.updatedAt), "dd MMM yyyy")} ·{" "}
                        {formatFileSize(thread.latestVersion.fileSize)}
                      </p>
                    </div>
                  </div>

                  <StatusBadge
                    {...documentReviewStatusBadge(thread.effectiveStatus)}
                    size="sm"
                  />
                </div>

                {/* Inline Feedback Note Banner */}
                {thread.effectiveReviewNotes && (
                  <div className="mt-2 flex items-start gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
                    <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <p className="line-clamp-3 text-foreground">
                      {thread.effectiveReviewNotes}
                    </p>
                  </div>
                )}

                {/* Action Strip */}
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setDrawerInitialVersionId(thread.latestVersion.id);
                        setDrawerThread(thread);
                      }}
                    >
                      <Eye className="mr-1 h-3 w-3" />
                      {viewerRole === "consultant"
                        ? "Review & Reply"
                        : "Preview & Feedback"}
                    </Button>

                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                    >
                      <a
                        href={getAppointmentDocumentUrl(
                          thread.appointmentId,
                          thread.latestVersion.id,
                          "attachment",
                        )}
                      >
                        <Download className="mr-1 h-3 w-3" />
                        Download
                      </a>
                    </Button>

                    {viewerRole === "consultee" &&
                      canUpload &&
                      needsRevision && (
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => {
                            setDrawerInitialVersionId(thread.latestVersion.id);
                            setDrawerThread(thread);
                          }}
                        >
                          <FileUp className="mr-1 h-3 w-3" />
                          Upload v{thread.versionCount + 1} Revision
                        </Button>
                      )}
                  </div>

                  {thread.versionCount > 1 && (
                    <button
                      type="button"
                      onClick={() => toggleTimeline(thread.rootId)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      {thread.versionCount} versions
                    </button>
                  )}
                </div>

                {/* Collapsible Version History Strip */}
                {isExpanded && thread.versionCount > 1 && (
                  <div className="mt-2.5 space-y-1.5 border-t pt-2">
                    {thread.versions.map((ver, idx) => {
                      const vNum = ver.versionNo ?? idx + 1;
                      const isExpert = ver.uploadedByRole === "CONSULTANT";
                      return (
                        <div
                          key={ver.id}
                          className="flex items-center justify-between rounded bg-muted/30 px-2 py-1 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="font-mono font-semibold">
                              v{vNum}
                            </span>
                            <Badge
                              variant="secondary"
                              className="h-4 px-1 text-[10px]"
                            >
                              {isExpert ? "Expert" : "Learner"}
                            </Badge>
                            <span className="truncate text-muted-foreground">
                              {ver.originalName}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setDrawerInitialVersionId(ver.id);
                              setDrawerThread(thread);
                            }}
                            className="ml-2 shrink-0 text-[11px] font-medium text-primary hover:underline"
                          >
                            Inspect
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Deliverable / Handout Upload Form */}
      {canUpload && (
        <div className="pt-1">
          {!showNewUploadForm ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowNewUploadForm(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {viewerRole === "consultee"
                ? "Upload New Deliverable"
                : "Share Handout / File"}
            </Button>
          ) : (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <p className="text-xs font-medium text-foreground">
                {viewerRole === "consultee"
                  ? "Upload a new document for review"
                  : "Share a standalone document with learner"}
              </p>
              <Input
                type="file"
                accept={ALLOWED_DOCUMENT_ACCEPT_ATTR}
                onChange={(e) => setNewFile(e.target.files?.[0] ?? null)}
                className="h-8 text-xs"
              />
              <Input
                type="text"
                placeholder="Optional description or context..."
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="h-8 text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!newFile || isUploadingNew}
                  onClick={() => void handleCreateRootDocument()}
                >
                  {isUploadingNew && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  Upload
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowNewUploadForm(false);
                    setNewFile(null);
                    setNewDescription("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <DocumentReviewDrawer
        thread={drawerThread}
        isOpen={Boolean(drawerThread)}
        onClose={() => {
          setDrawerThread(null);
          setDrawerInitialVersionId(undefined);
        }}
        viewerRole={viewerRole}
        canUpload={canUpload}
        initialVersionId={drawerInitialVersionId}
        onUpdated={refresh}
      />
    </div>
  );
}
