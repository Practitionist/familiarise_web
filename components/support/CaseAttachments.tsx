"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

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

export function CaseAttachments({
  caseId,
  canUpload = false,
  evidenceRequestId,
}: Readonly<{
  caseId: string;
  canUpload?: boolean;
  evidenceRequestId?: string;
}>) {
  const endpoint = `/api/support/cases/${caseId}/attachments`;
  const queryKey = ["support-case-attachments", caseId, evidenceRequestId];
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
    setUploading(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(evidenceRequestId ? { evidenceRequestId } : {}),
          originalName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
        }),
      });
      if (!response.ok) await throwSupportError(response, "attachment upload");
      const { data } = Upload.parse(await response.json());
      const stored = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
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
      {query.data?.map((file) => (
        <a
          key={file.id}
          className="block underline underline-offset-4"
          href={file.downloadUrl}
          target="_blank"
          rel="noreferrer"
        >
          {file.originalName}
        </a>
      ))}
      {canUpload && (
        <>
          <input
            ref={input}
            className="sr-only"
            type="file"
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
        </>
      )}
    </div>
  );
}
