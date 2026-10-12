"use client";

import { useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download, ExternalLink, Info } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { uploadBookingDocument } from "@/lib/documents/direct-upload";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import { FILE_ACCEPT_ATTR } from "@/lib/documents/file-policy";
import {
  THREAD_STATUS_CHIP,
  threadBannerText,
  type DayFormat,
} from "@/lib/documents/thread-copy";
import type { ThreadView } from "@/lib/documents/thread-view";
import { getDocumentViewerUrl } from "@/lib/documents/urls";
import { useFileDownload } from "@/lib/documents/use-file-download";
import { formatFileSize } from "@/lib/documents/document-utils";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import { ReviewComposer } from "./ReviewComposer";

interface BookingNames {
  viewerRole: "learner" | "expert";
  learnerName: string;
  expertName: string;
  organizationName: string | null;
}

async function send(
  url: string,
  init: RequestInit,
  role: BookingNames["viewerRole"],
) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new FileActionError(friendlyFileError("NETWORK"));
  }
  if (!res.ok) {
    throw new FileActionError(
      await friendlyErrorFromResponse(res, {
        role: role === "expert" ? "consultant" : "consultee",
      }),
    );
  }
}

/** One document thread: status, the banner naming who acts next, every version and the viewer's actions. */
export function ThreadCard({
  appointmentId,
  thread,
  names,
  day,
  focused,
  onChanged,
}: Readonly<{
  appointmentId: string;
  thread: ThreadView;
  names: BookingNames;
  day: DayFormat;
  focused: boolean;
  onChanged: () => void;
}>) {
  const { toast } = useToast();
  const { downloadDocument } = useFileDownload();
  const fileInput = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const [confirm, setConfirm] = useState<"withdraw" | "delete" | null>(null);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalNote, setRemovalNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const learner = names.viewerRole === "learner";
  const base = `/api/appointments/${encodeURIComponent(appointmentId)}/documents`;
  const latest = thread.versions.at(-1)!;
  const allowed = new Set(thread.allowedActions);

  const fail = (error: unknown) => {
    const copy =
      error instanceof FileActionError
        ? { title: error.title, description: error.message }
        : friendlyFileError("SERVER_ERROR");
    toast({
      title: copy.title,
      description: copy.description,
      variant: "destructive",
    });
    onChanged();
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadBookingDocument({
        appointmentId,
        file,
        parentDocumentId: thread.reviewTargetId,
      }),
    onSuccess: () => {
      toast({ title: "New version uploaded" });
      onChanged();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (documentId: string) =>
      send(
        `${base}/${encodeURIComponent(documentId)}`,
        { method: "DELETE" },
        names.viewerRole,
      ),
    onSuccess: () => {
      toast({ title: learner ? "Version withdrawn" : "File removed" });
      onChanged();
    },
    onError: fail,
  });

  const requestRemoval = useMutation({
    mutationFn: () =>
      send(
        `${base}/${encodeURIComponent(thread.rootId)}/removal-request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: removalNote.trim() || null }),
        },
        names.viewerRole,
      ),
    onSuccess: () => {
      setRemovalOpen(false);
      setRemovalNote("");
      toast({
        title: "Removal requested",
        description: "Support will reply in your session's support chat.",
      });
      onChanged();
    },
    onError: fail,
  });

  const chip = THREAD_STATUS_CHIP[thread.status];
  const capReached =
    learner &&
    thread.kind === "submission" &&
    (thread.status === "WAITING_FOR_EXPERT" ||
      thread.status === "NEEDS_REVISION") &&
    thread.learnerVersions.used >= thread.learnerVersions.max;

  return (
    <article
      id={`thread-${thread.rootId}`}
      className={`rounded-xl border bg-card ${focused ? "border-primary ring-1 ring-primary/30" : "border-border"}`}
      aria-label={thread.title}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {thread.title}
        </h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>v{thread.latestVersionNo}</span>
          <StatusBadge
            label={learner ? chip.learner : chip.expert}
            tone={chip.tone}
            size="sm"
          />
          {thread.removal && (
            <StatusBadge label="Removal requested" tone="warning" size="sm" />
          )}
        </div>
      </header>

      <div className="space-y-3 px-4 py-3">
        <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {threadBannerText({
              kind: thread.banner.kind,
              viewerRole: names.viewerRole,
              learnerName: names.learnerName,
              expertName: names.expertName,
              expertOrg: names.organizationName,
              since: thread.banner.since,
              versionNo: thread.banner.versionNo,
              day,
            })}
          </span>
        </p>

        <ol className="space-y-2">
          {[...thread.versions].reverse().map((v) => (
            <li
              key={v.id}
              className="flex flex-wrap items-start justify-between gap-2 text-xs"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-foreground">
                  <span className="font-medium">v{v.versionNo}</span>{" "}
                  <span className="text-muted-foreground">· {v.label}</span> ·{" "}
                  <span className="break-all">{v.originalName}</span>{" "}
                  <span className="text-muted-foreground">
                    · {formatFileSize(v.fileSize)} · {day(v.uploadedAt)}
                  </span>
                </p>
                {v.note && (
                  <p className="break-words text-muted-foreground">
                    &ldquo;{v.note}&rdquo;
                  </p>
                )}
                {v.reviewStatus &&
                  !v.superseded &&
                  v.reviewStatus !== "PENDING" && (
                    <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                      <StatusBadge
                        {...documentReviewStatusBadge(v.reviewStatus)}
                        size="sm"
                      />
                      {v.feedback && (
                        <span className="break-words">{v.feedback}</span>
                      )}
                    </p>
                  )}
                {v.superseded && v.feedback && (
                  <p className="break-words text-muted-foreground">
                    Feedback: {v.feedback}
                  </p>
                )}
                {v.storageMissing && (
                  <p className="text-destructive">
                    This file didn&apos;t finish saving.
                  </p>
                )}
              </div>
              {!v.storageMissing && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                  >
                    <a
                      href={getDocumentViewerUrl(v.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open
                      <ExternalLink className="ml-1 h-3 w-3" aria-hidden />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label={`Download ${v.originalName}`}
                    onClick={() =>
                      void downloadDocument(appointmentId, v.id, {
                        isUploader: (v.by === "learner") === learner,
                        role: learner ? "consultee" : "consultant",
                      })
                    }
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          {allowed.has("upload_version") && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {upload.isPending ? "Uploading…" : "Upload new version"}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept={FILE_ACCEPT_ATTR}
                className="sr-only"
                aria-label="Choose a new version"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) upload.mutate(file);
                }}
              />
            </>
          )}
          {capReached && (
            <span className="text-xs text-muted-foreground">
              All {thread.learnerVersions.max} versions used. Start a new
              document instead.
            </span>
          )}
          {allowed.has("withdraw_latest") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirm("withdraw")}
            >
              Withdraw v{latest.versionNo}
            </Button>
          )}
          {allowed.has("request_removal") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRemovalOpen(true)}
            >
              Request removal
            </Button>
          )}
          {allowed.has("delete_shared") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirm("delete")}
            >
              Delete file
            </Button>
          )}
          {allowed.has("review") && thread.reviewTargetId && (
            <Button
              type="button"
              size="sm"
              variant={reviewing ? "secondary" : "default"}
              aria-expanded={reviewing}
              onClick={() => setReviewing((open) => !open)}
            >
              {reviewing ? "Close review" : "Review"}
            </Button>
          )}
          {learner && thread.kind === "submission" && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {thread.learnerVersions.used} of {thread.learnerVersions.max}{" "}
              versions used
            </span>
          )}
        </div>

        {reviewing && thread.reviewTargetId && (
          <ReviewComposer
            appointmentId={appointmentId}
            documentId={thread.reviewTargetId}
            versionNo={thread.banner.versionNo}
            currentStatus={
              thread.versions.find((v) => v.id === thread.reviewTargetId)
                ?.reviewStatus ?? null
            }
            onDone={() => {
              setReviewing(false);
              onChanged();
            }}
            onFailed={onChanged}
          />
        )}
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "withdraw"
                ? `Withdraw v${latest.versionNo}?`
                : "Delete this file?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "withdraw"
                ? "Your expert will no longer see this version."
                : "The learner will no longer see this file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate(
                  confirm === "withdraw" ? latest.id : thread.rootId,
                );
                setConfirm(null);
              }}
            >
              {confirm === "withdraw" ? "Withdraw" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removalOpen} onOpenChange={setRemovalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Ask support to remove this document?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Reviewed documents are removed by support, so your expert&apos;s
              feedback is not lost by accident. Support will reply in your
              session&apos;s support chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor={noteId} className="text-xs">
              Reason (optional)
            </Label>
            <Textarea
              id={noteId}
              value={removalNote}
              maxLength={500}
              onChange={(e) => setRemovalNote(e.target.value)}
              className="min-h-[64px] text-sm"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={requestRemoval.isPending}
              onClick={(e) => {
                e.preventDefault();
                requestRemoval.mutate();
              }}
            >
              Request removal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
