import "server-only";

import Image from "next/image";
import Link from "next/link";
import { Download, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  signAuthorizedFile,
  type FileAccessOutcome,
} from "@/lib/documents/file-access";
import {
  friendlyFileError,
  type FileErrorCode,
} from "@/lib/documents/file-errors";

/** Embeds and download links outlive a slow page load but not a parked tab. */
const VIEWER_LINK_TTL_SECONDS = 300;

export function FileViewerError({
  code,
  viewerIsUploader = false,
  viewerRole,
  callbackPath,
  backHref,
}: Readonly<{
  code: FileErrorCode;
  viewerIsUploader?: boolean;
  viewerRole?: "consultee" | "consultant";
  callbackPath: string;
  /** The booking's documents page, when the file belongs to one. */
  backHref?: string | null;
}>) {
  const copy = friendlyFileError(code, {
    isUploader: viewerIsUploader,
    role: viewerRole,
  });
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{copy.title}</h1>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      {code === "UNAUTHORIZED" ? (
        <Button asChild>
          <Link
            href={`/auth/signin?callbackUrl=${encodeURIComponent(callbackPath)}`}
          >
            Sign in
          </Link>
        </Button>
      ) : (
        <div className="flex flex-wrap justify-center gap-2">
          {code === "STORAGE_UNAVAILABLE" && (
            <Button asChild variant="outline">
              <Link href={callbackPath}>Try again</Link>
            </Button>
          )}
          {backHref && (
            <Button asChild>
              <Link href={backHref}>Back to the session</Link>
            </Button>
          )}
        </div>
      )}
    </main>
  );
}

function sessionDocumentsHref(appointmentId: string | null): string | null {
  return appointmentId
    ? `/dashboard/go/auto/appointments/${encodeURIComponent(appointmentId)}/documents`
    : null;
}

/** Signs on every render, so a reload of the viewer tab never shows an expired link. */
export async function FileViewer({
  access,
  callbackPath,
}: Readonly<{
  access: FileAccessOutcome;
  callbackPath: string;
}>) {
  if (!access.ok) {
    return (
      <FileViewerError
        code={access.code}
        viewerIsUploader={access.viewerIsUploader}
        callbackPath={callbackPath}
        backHref={sessionDocumentsHref(access.appointmentId)}
      />
    );
  }

  const { file } = access;
  const [inline, attachment] = await Promise.all([
    file.previewable
      ? signAuthorizedFile(file, "inline", VIEWER_LINK_TTL_SECONDS)
      : null,
    signAuthorizedFile(file, "attachment", VIEWER_LINK_TTL_SECONDS),
  ]);
  const failed = !attachment.ok
    ? attachment
    : inline && !inline.ok
      ? inline
      : null;
  if (failed && !failed.ok) {
    return (
      <FileViewerError
        code={failed.code}
        viewerIsUploader={file.viewerIsUploader}
        viewerRole={file.viewerRole}
        callbackPath={callbackPath}
        backHref={sessionDocumentsHref(file.appointmentId)}
      />
    );
  }
  if (!attachment.ok) return null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
          <FileText
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate">{file.originalName}</span>
        </h1>
        <Button asChild size="sm" variant="outline">
          <a href={attachment.signedUrl} rel="noopener noreferrer">
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Download
          </a>
        </Button>
      </div>
      {inline?.ok ? (
        file.mimeType.startsWith("image/") ? (
          <div className="relative h-[80vh] w-full rounded-lg border">
            <Image
              src={inline.signedUrl}
              alt={file.originalName}
              fill
              unoptimized
              className="object-contain"
            />
          </div>
        ) : (
          <iframe
            title={file.originalName}
            src={inline.signedUrl}
            className="h-[80vh] w-full rounded-lg border bg-background"
          />
        )
      ) : (
        <p className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          This file type can&apos;t be shown in the browser. Download it to open
          it on your device.
        </p>
      )}
    </main>
  );
}
