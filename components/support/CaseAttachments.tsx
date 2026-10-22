"use client";

import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIME_TYPES,
  type SupportAttachmentMimeType,
} from "@/lib/support/attachment-policy";
import { supportKeys } from "@/lib/support/support-keys";

const AttachmentList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      originalName: z.string(),
      fileSize: z.number(),
      downloadUrl: z.string(),
    }),
  ),
});
const Upload = z.object({
  data: z.object({ id: z.string(), uploadUrl: z.string() }),
});

const ALLOWED_TYPES = new Set<string>(SUPPORT_ATTACHMENT_MIME_TYPES);

/** The upload route's allowlist, checked here so a wrong file fails before any round trip. */
const EXTENSION_TYPES: Record<string, SupportAttachmentMimeType> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Some browsers leave `type` empty (often for .docx); fall back to the extension. */
export function attachmentType(file: { name: string; type: string }): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type || EXTENSION_TYPES[extension] || "";
}

export function attachmentProblem(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  const type = attachmentType(file);
  if (!ALLOWED_TYPES.has(type))
    return "Choose a PDF, JPEG, PNG, WebP, text or Word (.docx) file.";
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES)
    return "Files can be up to 20 MB.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CaseAttachments({
  caseId,
  canUpload = false,
  evidenceRequestId,
  uploadNote,
}: Readonly<{
  caseId: string;
  canUpload?: boolean;
  evidenceRequestId?: string;
  /** Shown beside the upload control, e.g. who will be able to see the file. */
  uploadNote?: ReactNode;
}>) {
  const endpoint = `/api/support/cases/${caseId}/attachments`;
  const queryKey = supportKeys.attachments(caseId, evidenceRequestId);
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        evidenceRequestId
          ? `${endpoint}?evidenceRequestId=${encodeURIComponent(evidenceRequestId)}`
          : endpoint,
      );
      if (!res.ok) await throwSupportError(res, "attachments load");
      return AttachmentList.parse(await res.json()).data;
    },
  });
  const upload = async (file: File) => {
    if (uploading) return;
    const problem = attachmentProblem(file);
    if (problem) {
      toast({
        title: "This file can't be attached",
        description: problem,
        variant: "destructive",
      });
      if (input.current) input.current.value = "";
      return;
    }
    const mimeType = attachmentType(file);
    setUploading(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(evidenceRequestId ? { evidenceRequestId } : {}),
          originalName: file.name,
          mimeType,
          fileSize: file.size,
        }),
      });
      if (!response.ok) await throwSupportError(response, "attachment upload");
      const { data } = Upload.parse(await response.json());
      const stored = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: file,
      });
      if (!stored.ok) throw new Error("The file upload failed. Please retry.");
      const completed = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentId: data.id }),
      });
      if (!completed.ok)
        await throwSupportError(completed, "attachment completion");
      await qc.invalidateQueries({ queryKey });
    } catch (error) {
      toast({
        title: "The attachment was not uploaded",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="space-y-2 border-t border-border p-3 text-xs">
      <p className="font-medium">Attachments</p>
      {query.isError && (
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Retry loading attachments
        </Button>
      )}
      {query.data && query.data.length > 0 && (
        <ul className="space-y-1">
          {query.data.map((file) => (
            <li key={file.id}>
              <a
                className="underline underline-offset-4"
                href={file.downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                {file.originalName}
              </a>
              <span className="text-muted-foreground">
                {" "}
                · {formatFileSize(file.fileSize)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            className="sr-only"
            type="file"
            accept={SUPPORT_ATTACHMENT_ACCEPT}
            aria-label="Upload attachment"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => input.current?.click()}
          >
            {uploading ? "Uploading…" : "Attach a file"}
          </Button>
          <span className="text-muted-foreground">
            PDF, image, text or .docx, up to 20 MB.
          </span>
          {uploadNote}
        </div>
      )}
    </div>
  );
}
