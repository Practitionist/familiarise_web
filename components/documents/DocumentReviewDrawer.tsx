"use client";

import React, { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  FileUp,
  Loader2,
  MessageSquare,
  Paperclip,
  RotateCcw,
  XCircle,
} from "lucide-react";

import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import {
  ALLOWED_DOCUMENT_ACCEPT_ATTR,
  isReviewTransitionAllowed,
  type DocumentThread,
  type ReviewStatus,
  type ThreadableDocument,
} from "@/lib/documents/document-review";
import {
  getAppointmentDocumentUrl,
  isPreviewableMimeType,
} from "@/lib/documents/urls";
import { formatFileSize } from "@/lib/documents/document-utils";

interface DocumentReviewDrawerProps {
  thread: DocumentThread<ThreadableDocument> | null;
  isOpen: boolean;
  onClose: () => void;
  viewerRole: "consultee" | "consultant";
  canUpload?: boolean;
  initialVersionId?: string;
  onUpdated?: () => void;
}

const CONSULTANT_STATUS_OPTIONS = [
  {
    value: "APPROVED",
    label: "Approve",
    icon: CheckCircle2,
  },
  {
    value: "NEEDS_REVISION",
    label: "Request Revision",
    icon: RotateCcw,
  },
  {
    value: "IN_REVIEW",
    label: "In Review",
    icon: MessageSquare,
  },
  {
    value: "REJECTED",
    label: "Reject",
    icon: XCircle,
  },
] as const;

export function DocumentReviewDrawer({
  thread,
  isOpen,
  onClose,
  viewerRole,
  canUpload = false,
  initialVersionId,
  onUpdated,
}: Readonly<DocumentReviewDrawerProps>) {
  const { toast } = useToast();
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [statusDraft, setStatusDraft] = useState<string>("");
  const [notesDraft, setNotesDraft] = useState<string>("");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [revisionNote, setRevisionNote] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  const reviewTarget =
    thread?.latestConsulteeSubmission ?? thread?.latestVersion ?? null;

  useEffect(() => {
    if (!thread) return;
    const defaultId =
      initialVersionId && thread.versions.some((v) => v.id === initialVersionId)
        ? initialVersionId
        : thread.latestVersion.id;
    setSelectedVersionId(defaultId);
    setStatusDraft(reviewTarget?.reviewStatus ?? "PENDING");
    setNotesDraft(thread.effectiveReviewNotes ?? "");
    setAttachmentFile(null);
    setRevisionNote("");
  }, [thread, initialVersionId, reviewTarget?.reviewStatus]);

  if (!thread) return null;

  const activeVersion =
    thread.versions.find((v) => v.id === selectedVersionId) ??
    thread.latestVersion;

  const inlineUrl = getAppointmentDocumentUrl(
    thread.appointmentId,
    activeVersion.id,
    "inline",
  );
  const downloadUrl = getAppointmentDocumentUrl(
    thread.appointmentId,
    activeVersion.id,
    "attachment",
  );
  const canPreviewInline = isPreviewableMimeType(activeVersion.mimeType);
  const isImage = activeVersion.mimeType.startsWith("image/");

  const handleSaveConsultantReview = async () => {
    if (!reviewTarget) return;
    setIsSaving(true);
    try {
      const patchRes = await fetch(
        `/api/appointments/${thread.appointmentId}/documents/${reviewTarget.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewStatus: statusDraft || undefined,
            reviewNotes: notesDraft.trim(),
          }),
        },
      );

      if (!patchRes.ok) {
        const errBody = await patchRes.json().catch(() => null);
        throw new Error(
          errBody?.message || errBody?.error || "Failed to update review",
        );
      }

      if (attachmentFile) {
        const formData = new FormData();
        formData.append("file", attachmentFile);
        formData.append("responseToDocumentId", reviewTarget.id);
        if (notesDraft.trim()) {
          formData.append("description", notesDraft.trim());
        }
        const uploadRes = await fetch(
          `/api/appointments/${thread.appointmentId}/documents/consultant`,
          {
            method: "POST",
            body: formData,
          },
        );
        if (!uploadRes.ok) {
          const uploadErr = await uploadRes.json().catch(() => null);
          toast({
            title: "Review saved",
            description: `Status and notes were saved, but response attachment upload failed: ${
              uploadErr?.message || uploadErr?.error || "Unknown upload error"
            }`,
            variant: "destructive",
          });
          setAttachmentFile(null);
          onUpdated?.();
          return;
        }
      }

      toast({
        title: "Review saved",
        description: attachmentFile
          ? "Feedback notes and annotated response file sent."
          : `Status updated to ${documentReviewStatusBadge(statusDraft).label}.`,
      });
      setAttachmentFile(null);
      onUpdated?.();
      onClose();
    } catch (err) {
      toast({
        title: "Unable to save review",
        description:
          err instanceof Error ? err.message : "Failed to save review",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUploadConsulteeRevision = async () => {
    if (!attachmentFile) {
      toast({
        title: "Select a file",
        description: "Choose a revised file to upload.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const formData = new FormData();
      formData.append("file", attachmentFile);
      formData.append("responseToDocumentId", thread.latestVersion.id);
      if (revisionNote.trim()) {
        formData.append("description", revisionNote.trim());
      }

      const res = await fetch(
        `/api/appointments/${thread.appointmentId}/documents`,
        {
          method: "POST",
          body: formData,
        },
      );

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(
          errBody?.message || errBody?.error || "Failed to upload revision",
        );
      }

      toast({
        title: `Uploaded v${thread.versionCount + 1}`,
        description:
          "Your revised document has been threaded and sent for review.",
      });
      setAttachmentFile(null);
      setRevisionNote("");
      onUpdated?.();
      onClose();
    } catch (err) {
      toast({
        title: "Upload failed",
        description:
          err instanceof Error ? err.message : "Failed to upload revision",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ResponsiveModal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveModalContent className="max-w-5xl">
        <ResponsiveModalHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <div className="min-w-0">
              <ResponsiveModalTitle className="truncate text-base font-semibold">
                {thread.title}
              </ResponsiveModalTitle>
              <ResponsiveModalDescription className="text-xs">
                Deliverable thread · {thread.versionCount}{" "}
                {thread.versionCount === 1 ? "version" : "versions"} · Latest{" "}
                {format(new Date(thread.updatedAt), "dd MMM yyyy, h:mm a")}
              </ResponsiveModalDescription>
            </div>
            <StatusBadge
              {...documentReviewStatusBadge(thread.effectiveStatus)}
              size="sm"
            />
          </div>
        </ResponsiveModalHeader>

        <div className="grid grid-cols-1 gap-4 py-2 lg:grid-cols-12">
          {/* Left 7 columns: Live Document Preview */}
          <div className="flex flex-col space-y-2 lg:col-span-7">
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-xs">
              <span className="truncate font-medium text-foreground">
                v{activeVersion.versionNo ?? 1} · {activeVersion.originalName}{" "}
                <span className="text-muted-foreground">
                  ({formatFileSize(activeVersion.fileSize)})
                </span>
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <a
                  href={inlineUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  Open
                  <ExternalLink className="h-3 w-3" />
                </a>
                <span className="text-muted-foreground">·</span>
                <a
                  href={downloadUrl}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Download
                  <Download className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="flex min-h-[380px] flex-1 items-center justify-center overflow-hidden rounded-lg border bg-muted/20">
              {canPreviewInline ? (
                isImage ? (
                  <object
                    data={inlineUrl}
                    type={activeVersion.mimeType}
                    aria-label={activeVersion.originalName}
                    className="max-h-[60vh] max-w-full object-contain p-2"
                  />
                ) : (
                  <iframe
                    title={activeVersion.originalName}
                    src={inlineUrl}
                    sandbox="allow-scripts"
                    className="h-[60vh] w-full border-0"
                  />
                )
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center">
                  <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    {activeVersion.originalName}
                  </p>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                    Inline preview is available for PDFs, images, and text
                    files. Download this file to inspect it locally.
                  </p>
                  <Button asChild size="sm" variant="outline" className="mt-4">
                    <a href={downloadUrl}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Download ({formatFileSize(activeVersion.fileSize)})
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Right 5 columns: Version Switcher + Review/Revision Controls */}
          <div className="flex flex-col justify-between space-y-4 lg:col-span-5">
            <div className="space-y-4">
              {/* Version Timeline Switcher */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Version History
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {thread.versions.map((ver, idx) => {
                    const isSelected = ver.id === activeVersion.id;
                    const vNum = ver.versionNo ?? idx + 1;
                    const isExpert = ver.uploadedByRole === "CONSULTANT";
                    return (
                      <button
                        key={ver.id}
                        type="button"
                        onClick={() => setSelectedVersionId(ver.id)}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-foreground hover:bg-muted"
                        }`}
                      >
                        <span>v{vNum}</span>
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 text-[10px]"
                        >
                          {isExpert ? "Expert" : "Learner"}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
                {activeVersion.description && (
                  <p className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                    Note on v{activeVersion.versionNo ?? 1}:{" "}
                    {activeVersion.description}
                  </p>
                )}
              </div>

              {/* Consultant Review Form */}
              {viewerRole === "consultant" ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Review & Feedback
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {CONSULTANT_STATUS_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      const active = statusDraft === opt.value;
                      const allowed = reviewTarget
                        ? isReviewTransitionAllowed(
                            reviewTarget.reviewStatus as ReviewStatus,
                            opt.value,
                          )
                        : true;
                      return (
                        <Button
                          key={opt.value}
                          type="button"
                          size="sm"
                          disabled={!allowed}
                          variant={active ? "default" : "outline"}
                          className="justify-start text-xs"
                          onClick={() => setStatusDraft(opt.value)}
                        >
                          <Icon className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{opt.label}</span>
                        </Button>
                      );
                    })}
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="drawer-review-notes"
                      className="text-xs font-medium text-foreground"
                    >
                      Feedback notes for learner
                    </label>
                    <Textarea
                      id="drawer-review-notes"
                      rows={4}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      placeholder="Share actionable feedback, edits needed, or approval notes..."
                      className="text-xs"
                    />
                  </div>

                  {canUpload && (
                    <div className="space-y-1">
                      <label
                        htmlFor="drawer-consultant-attachment"
                        className="inline-flex items-center gap-1 text-xs font-medium text-foreground"
                      >
                        <Paperclip className="h-3 w-3" />
                        Attach marked-up file (optional)
                      </label>
                      <Input
                        id="drawer-consultant-attachment"
                        type="file"
                        accept={ALLOWED_DOCUMENT_ACCEPT_ATTR}
                        onChange={(e) =>
                          setAttachmentFile(e.target.files?.[0] ?? null)
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                  )}
                </div>
              ) : (
                /* Consultee Feedback Readout + Upload Revision */
                <div className="space-y-3">
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Expert Feedback
                    </p>
                    {thread.effectiveReviewNotes ? (
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {thread.effectiveReviewNotes}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No written feedback notes on this thread yet.
                      </p>
                    )}

                    {thread.latestConsultantResponse && (
                      <div className="flex items-center justify-between rounded border bg-background px-2.5 py-1.5 text-xs">
                        <span className="truncate font-medium">
                          Attached response:{" "}
                          {thread.latestConsultantResponse.originalName}
                        </span>
                        <a
                          href={getAppointmentDocumentUrl(
                            thread.appointmentId,
                            thread.latestConsultantResponse.id,
                            "attachment",
                          )}
                          className="ml-2 inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
                        >
                          Download
                          <Download className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>

                  {canUpload && (
                    <div className="space-y-2.5 rounded-lg border p-3">
                      <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <FileUp className="h-3.5 w-3.5" />
                        Upload Revision (v{thread.versionCount + 1})
                      </p>
                      <Input
                        type="file"
                        accept={ALLOWED_DOCUMENT_ACCEPT_ATTR}
                        onChange={(e) =>
                          setAttachmentFile(e.target.files?.[0] ?? null)
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="text"
                        placeholder="Optional summary of changes in this version..."
                        value={revisionNote}
                        onChange={(e) => setRevisionNote(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          {viewerRole === "consultant" ? (
            <Button
              size="sm"
              onClick={() => void handleSaveConsultantReview()}
              disabled={isSaving}
            >
              {isSaving && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Save Feedback
            </Button>
          ) : (
            canUpload && (
              <Button
                size="sm"
                onClick={() => void handleUploadConsulteeRevision()}
                disabled={isSaving || !attachmentFile}
              >
                {isSaving && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                Upload v{thread.versionCount + 1} Revision
              </Button>
            )
          )}
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
