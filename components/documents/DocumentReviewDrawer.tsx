"use client";

import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Loader2,
  MessageSquare,
  Paperclip,
  RotateCcw,
  Trash2,
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
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import { FileOpenLink } from "@/components/documents/FileOpenLink";
import {
  ALLOWED_DOCUMENT_ACCEPT_ATTR,
  isReviewTransitionAllowed,
  learnerRevisionGate,
  versionAuthorLabel,
  type DocumentThread,
  type ReviewStatus,
  type ThreadableDocument,
} from "@/lib/documents/document-review";
import { getDocumentViewerUrl } from "@/lib/documents/urls";
import { useFileDownload } from "@/lib/documents/use-file-download";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import { formatFileSize } from "@/lib/documents/document-utils";
import { uploadAppointmentDocumentWithProgress } from "@/lib/documents/direct-upload";
import { useZonedFormat } from "@/lib/time/zoned-format";

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

function DocumentThreadActionControls({
  viewerRole,
  thread,
  reviewTarget,
  statusDraft,
  setStatusDraft,
  notesDraft,
  setNotesDraft,
  canUpload,
  revisionBlockedReason,
  revisionNote,
  setRevisionNote,
  setAttachmentFile,
  uploadProgress,
  onDownloadVersion,
}: Readonly<{
  viewerRole: "consultee" | "consultant";
  thread: DocumentThread<ThreadableDocument>;
  reviewTarget: ThreadableDocument | null;
  statusDraft: string;
  setStatusDraft: (val: string) => void;
  notesDraft: string;
  setNotesDraft: (val: string) => void;
  canUpload: boolean;
  revisionBlockedReason: string | null;
  revisionNote: string;
  setRevisionNote: (val: string) => void;
  setAttachmentFile: (file: File | null) => void;
  uploadProgress: number | null;
  onDownloadVersion: (doc: ThreadableDocument) => void;
}>) {
  if (viewerRole === "consultant") {
    if (!reviewTarget) {
      return (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          Expert resource shared with learner — no learner submission awaiting
          review in this thread.
        </div>
      );
    }

    return (
      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Review & Feedback
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {CONSULTANT_STATUS_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = statusDraft === opt.value;
            const allowed = isReviewTransitionAllowed(
              reviewTarget.reviewStatus as ReviewStatus,
              opt.value,
            );
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
              onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)}
              className="h-8 text-xs"
            />
            {uploadProgress !== null && (
              <p className="text-[11px] text-muted-foreground">
                Uploading attachment... {uploadProgress}%
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  const latestReply =
    thread.latestConsultantResponse &&
    thread.latestConsultantResponse.id !== thread.rootId
      ? thread.latestConsultantResponse
      : null;

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
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

        {latestReply && (
          <div className="flex items-center justify-between rounded border bg-background px-2.5 py-1.5 text-xs">
            <span className="truncate font-medium">
              Expert reply: {latestReply.originalName}
            </span>
            <button
              type="button"
              onClick={() => onDownloadVersion(latestReply)}
              className="ml-2 inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
            >
              Download
              <Download className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {revisionBlockedReason && (
        <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          {revisionBlockedReason}
        </p>
      )}

      {canUpload && (
        <div className="space-y-2.5 rounded-lg border p-3">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <FileUp className="h-3.5 w-3.5" />
            Upload new version
          </p>
          <Input
            type="file"
            aria-label="Select revised file"
            accept={ALLOWED_DOCUMENT_ACCEPT_ATTR}
            onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)}
            className="h-8 text-xs"
          />
          <Input
            type="text"
            aria-label="Summary of changes"
            placeholder="Optional summary of changes in this version..."
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
            className="h-8 text-xs"
          />
          {uploadProgress !== null && (
            <p className="text-[11px] text-muted-foreground">
              Uploading... {uploadProgress}%
            </p>
          )}
        </div>
      )}
    </div>
  );
}

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
  const { downloadDocument } = useFileDownload();
  const formatZoned = useZonedFormat();
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [statusDraft, setStatusDraft] = useState<string>("");
  const [notesDraft, setNotesDraft] = useState<string>("");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [revisionNote, setRevisionNote] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const threadRef = React.useRef(thread);
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  const reviewTarget = thread?.latestConsulteeSubmission ?? null;
  const threadRootId = thread?.rootId;

  useEffect(() => {
    const current = threadRef.current;
    if (!isOpen || !current) return;
    const defaultId =
      initialVersionId &&
      current.versions.some((v) => v.id === initialVersionId)
        ? initialVersionId
        : current.latestVersion.id;
    setSelectedVersionId(defaultId);
    setStatusDraft(
      current.latestConsulteeSubmission?.reviewStatus ??
        current.latestVersion.reviewStatus ??
        "PENDING",
    );
    setNotesDraft(current.effectiveReviewNotes ?? "");
    setAttachmentFile(null);
    setRevisionNote("");
    setUploadProgress(null);
  }, [isOpen, threadRootId, initialVersionId]);

  useEffect(() => {
    if (!isSaving && reviewTarget?.reviewStatus) {
      setStatusDraft(reviewTarget.reviewStatus);
    }
  }, [isSaving, reviewTarget?.reviewStatus]);

  const activeVersion =
    thread?.versions.find((v) => v.id === selectedVersionId) ??
    thread?.latestVersion ??
    null;

  if (!thread || !activeVersion) return null;

  const revisionGate = learnerRevisionGate(
    thread.rootDocument.uploadedByRole,
    thread.versions,
  );
  const canUploadRevision =
    viewerRole === "consultee" && canUpload && revisionGate.allowed;
  const revisionBlockedReason =
    viewerRole === "consultee" &&
    canUpload &&
    !revisionGate.allowed &&
    thread.rootDocument.uploadedByRole === "CONSULTEE"
      ? friendlyFileError(revisionGate.code).description
      : null;

  const canDeleteActiveVersion =
    (viewerRole === "consultee" &&
      activeVersion.uploadedByRole === "CONSULTEE" &&
      activeVersion.reviewStatus === "PENDING") ||
    (viewerRole === "consultant" &&
      activeVersion.uploadedByRole === "CONSULTANT" &&
      activeVersion.rootDocumentId === null);

  const handleDeleteActiveVersion = async () => {
    const res = await fetch(
      `/api/appointments/${thread.appointmentId}/documents/${activeVersion.id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const error = await friendlyErrorFromResponse(res, {
        isUploader: true,
        role: viewerRole,
      });
      toast({
        title: "Unable to delete file",
        description: error.description,
        variant: "destructive",
      });
      throw new Error("Delete failed");
    }

    toast({
      title: "Document deleted",
      description: `${activeVersion.originalName} has been removed.`,
    });
    onUpdated?.();
    onClose();
  };

  const handleSaveConsultantReview = async () => {
    if (!reviewTarget) return;
    setIsSaving(true);
    setUploadProgress(null);
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
        throw new FileActionError(
          await friendlyErrorFromResponse(patchRes, { role: "consultant" }),
        );
      }

      if (attachmentFile) {
        try {
          await uploadAppointmentDocumentWithProgress({
            appointmentId: thread.appointmentId,
            file: attachmentFile,
            role: "consultant",
            responseToDocumentId: reviewTarget.id,
            description: notesDraft.trim() || undefined,
            onProgress: (pct) => setUploadProgress(pct),
          });
        } catch (uploadErr) {
          toast({
            title: "Review saved",
            description: `Status and notes were saved, but the reply file didn't upload. ${
              uploadErr instanceof Error
                ? uploadErr.message
                : "Something went wrong. Try again."
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
        title:
          err instanceof FileActionError ? err.title : "Unable to save review",
        description:
          err instanceof Error
            ? err.message
            : "Something went wrong. Try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
      setUploadProgress(null);
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
    setUploadProgress(0);
    try {
      await uploadAppointmentDocumentWithProgress({
        appointmentId: thread.appointmentId,
        file: attachmentFile,
        role: "consultee",
        responseToDocumentId: thread.latestVersion.id,
        description: revisionNote.trim() || undefined,
        onProgress: (pct) => setUploadProgress(pct),
      });

      toast({
        title: "New version uploaded",
        description: "Your expert will review this version next.",
      });
      setAttachmentFile(null);
      setRevisionNote("");
      onUpdated?.();
      onClose();
    } catch (err) {
      toast({
        title: err instanceof FileActionError ? err.title : "Upload failed",
        description:
          err instanceof Error
            ? err.message
            : "Something went wrong. Try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
      setUploadProgress(null);
    }
  };

  const isExpertHandoutRoot =
    thread.rootDocument.uploadedByRole === "CONSULTANT";
  const showConsultantSave =
    viewerRole === "consultant" && Boolean(reviewTarget);
  const showConsulteeSave = canUploadRevision;

  const triggerDownload = (doc: ThreadableDocument) => {
    void downloadDocument(thread.appointmentId, doc.id, {
      isUploader:
        (doc.uploadedByRole === "CONSULTEE") === (viewerRole === "consultee"),
      role: viewerRole,
    });
  };

  return (
    <ResponsiveModal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveModalContent className="max-w-3xl">
        <ResponsiveModalHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <div className="min-w-0">
              <ResponsiveModalTitle className="truncate text-base font-semibold">
                {thread.title}
              </ResponsiveModalTitle>
              <ResponsiveModalDescription className="text-xs">
                Deliverable thread · {thread.versionCount}{" "}
                {thread.versionCount === 1 ? "version" : "versions"} · Latest{" "}
                {formatZoned(thread.updatedAt, "dd MMM yyyy, h:mm a")}
              </ResponsiveModalDescription>
            </div>
            {isExpertHandoutRoot ? (
              <Badge variant="secondary">Shared by Expert</Badge>
            ) : (
              <StatusBadge
                {...documentReviewStatusBadge(thread.effectiveStatus)}
                size="sm"
              />
            )}
          </div>
        </ResponsiveModalHeader>

        <div className="space-y-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs">
            <span className="min-w-0 truncate font-medium text-foreground">
              v{activeVersion.versionNo ?? 1} · {activeVersion.originalName}{" "}
              <span className="text-muted-foreground">
                ({formatFileSize(activeVersion.fileSize)})
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <FileOpenLink
                href={getDocumentViewerUrl(activeVersion.id)}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                Open
                <ExternalLink className="h-3 w-3" aria-hidden />
              </FileOpenLink>
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <button
                type="button"
                onClick={() => triggerDownload(activeVersion)}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                Download
                <Download className="h-3 w-3" aria-hidden />
              </button>
              {canDeleteActiveVersion && (
                <>
                  <span className="text-muted-foreground" aria-hidden>
                    ·
                  </span>
                  <ConfirmDialog
                    title="Delete this document?"
                    description={`"${activeVersion.originalName}" will be permanently removed from this thread.`}
                    confirmLabel="Delete"
                    tone="destructive"
                    onConfirm={handleDeleteActiveVersion}
                    trigger={
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-medium text-destructive hover:underline"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                        Delete
                      </button>
                    }
                  />
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Revision &amp; Feedback Timeline
              </p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {thread.versions.map((ver, idx) => {
                  const isSelected = ver.id === activeVersion.id;
                  const vNum = ver.versionNo ?? idx + 1;
                  return (
                    <button
                      key={ver.id}
                      type="button"
                      onClick={() => setSelectedVersionId(ver.id)}
                      className={`flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted/60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="font-mono font-semibold">
                            v{vNum}
                          </span>
                          <Badge
                            variant="secondary"
                            className="h-4 shrink-0 px-1 text-[10px]"
                          >
                            {versionAuthorLabel(ver, thread.rootId, viewerRole)}
                          </Badge>
                          <span className="truncate font-medium">
                            {ver.originalName}
                          </span>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatZoned(ver.uploadedAt, "d MMM")}
                        </span>
                      </div>
                      {ver.description && (
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                          Note: {ver.description}
                        </p>
                      )}
                      {ver.reviewNotes && (
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                          Feedback: {ver.reviewNotes}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <DocumentThreadActionControls
              viewerRole={viewerRole}
              thread={thread}
              reviewTarget={reviewTarget}
              statusDraft={statusDraft}
              setStatusDraft={setStatusDraft}
              notesDraft={notesDraft}
              setNotesDraft={setNotesDraft}
              canUpload={
                viewerRole === "consultant" ? canUpload : canUploadRevision
              }
              revisionBlockedReason={revisionBlockedReason}
              revisionNote={revisionNote}
              setRevisionNote={setRevisionNote}
              setAttachmentFile={setAttachmentFile}
              uploadProgress={uploadProgress}
              onDownloadVersion={triggerDownload}
            />
          </div>
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          {showConsultantSave && (
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
          )}
          {showConsulteeSave && (
            <Button
              size="sm"
              onClick={() => void handleUploadConsulteeRevision()}
              disabled={isSaving || !attachmentFile}
            >
              {isSaving && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Upload new version
            </Button>
          )}
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
