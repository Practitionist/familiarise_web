"use client";

import { useCallback, useId, useRef, useState } from "react";
import { UploadCloud, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { uploadBookingDocument } from "@/lib/documents/direct-upload";
import {
  FileActionError,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import {
  FILE_ACCEPT_ATTR,
  FILE_POLICY_HINT,
  validateUploadFile,
} from "@/lib/documents/file-policy";
import { cn } from "@/utils/tailwind";

const CONCURRENCY = 3;

interface QueuedFile {
  key: string;
  file: File;
  status: "queued" | "uploading" | "done" | "failed";
  progress: number;
  error: string | null;
}

/**
 * Drop or pick several files; each is checked against the file policy before
 * any request, then presigned, uploaded and committed on its own, three at a time.
 */
export function BulkUploadDropzone({
  appointmentId,
  used,
  max,
  label,
  onUploaded,
}: Readonly<{
  appointmentId: string;
  used: number;
  max: number;
  label: string;
  onUploaded: () => void;
}>) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);

  const patch = useCallback(
    (key: string, next: Partial<QueuedFile>) =>
      setQueue((q) => q.map((f) => (f.key === key ? { ...f, ...next } : f))),
    [],
  );

  const run = useCallback(
    async (items: QueuedFile[]) => {
      const pending = items.filter((i) => i.status === "queued");
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const item = pending[cursor++]!;
          patch(item.key, { status: "uploading" });
          try {
            await uploadBookingDocument({
              appointmentId,
              file: item.file,
              onProgress: (progress) => patch(item.key, { progress }),
            });
            patch(item.key, { status: "done", progress: 100 });
          } catch (error) {
            const copy =
              error instanceof FileActionError
                ? error.message
                : friendlyFileError("SERVER_ERROR").description;
            patch(item.key, { status: "failed", error: copy });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      onUploaded();
    },
    [appointmentId, onUploaded, patch],
  );

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = Math.max(0, max - used);
    const next = Array.from(files).map((file, index): QueuedFile => {
      const key = `${file.name}-${file.size}-${Date.now()}-${index}`;
      if (index >= room) {
        return {
          key,
          file,
          status: "failed",
          progress: 0,
          error: friendlyFileError("DOCUMENT_LIMIT_REACHED").description,
        };
      }
      const policy = validateUploadFile(file);
      return policy.ok
        ? { key, file, status: "queued", progress: 0, error: null }
        : {
            key,
            file,
            status: "failed",
            progress: 0,
            error: friendlyFileError(policy.code).description,
          };
    });
    setQueue((q) => [...q, ...next]);
    void run(next);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm transition-colors hover:bg-muted/50",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <UploadCloud className="h-5 w-5 text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {FILE_POLICY_HINT} · {used}/{max} used
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={FILE_ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => addFiles(e.target.files)}
        />
      </label>
      {queue.length > 0 && (
        <ul className="space-y-1.5" aria-live="polite">
          {queue.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {item.file.name}
              </span>
              {item.status === "uploading" && (
                <Progress value={item.progress} className="h-1.5 w-24" />
              )}
              {item.status === "queued" && (
                <span className="text-muted-foreground">Waiting…</span>
              )}
              {item.status === "done" && (
                <span className="text-emerald-700 dark:text-emerald-400">
                  Uploaded
                </span>
              )}
              {item.status === "failed" && (
                <span className="text-destructive">{item.error}</span>
              )}
              {(item.status === "done" || item.status === "failed") && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  aria-label={`Dismiss ${item.file.name}`}
                  onClick={() =>
                    setQueue((q) => q.filter((f) => f.key !== item.key))
                  }
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
