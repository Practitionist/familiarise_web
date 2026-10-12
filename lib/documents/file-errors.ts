import { z } from "zod";

import {
  MAX_DOCS_PER_APPOINTMENT,
  MAX_DOCUMENT_BYTES,
  MAX_LEARNER_VERSIONS_PER_THREAD,
} from "./document-review";

/** Error body every document/material route returns; extra fields are ignored. */
export const FileApiErrorBodySchema = z.object({
  code: z.string().optional(),
});

export const FileErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "GONE",
  "APPOINTMENT_TERMINAL",
  "STORAGE_MISSING",
  "STORAGE_UNAVAILABLE",
  "SUPERSEDED",
  "THREAD_CLOSED",
  "THREAD_IN_REVIEW",
  "INVALID_THREAD_PARENT",
  "VERSION_LIMIT_REACHED",
  "DOCUMENT_LIMIT_REACHED",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "RATE_LIMITED",
  "NETWORK",
  "SERVER_ERROR",
]);
export type FileErrorCode = z.infer<typeof FileErrorCode>;

export interface FriendlyFileError {
  code: FileErrorCode;
  title: string;
  description: string;
}

export interface FileErrorViewer {
  /** Whether the viewer uploaded the file the error is about. */
  isUploader?: boolean;
  role?: "consultee" | "consultant";
}

/** Server codes that predate the shared vocabulary. */
const CODE_ALIASES: Record<string, FileErrorCode> = {
  BOOKING_TERMINAL: "APPOINTMENT_TERMINAL",
  STORAGE_CONFIG_ERROR: "STORAGE_UNAVAILABLE",
};

function codeFromStatus(status: number): FileErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 410) return "GONE";
  if (status === 413) return "FILE_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_FILE_TYPE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "STORAGE_UNAVAILABLE";
  return "SERVER_ERROR";
}

/** The `code` wins; the HTTP status only fills in when the body carries no known code. */
export function resolveFileErrorCode(
  status: number,
  rawCode?: string | null,
): FileErrorCode {
  if (rawCode) {
    const aliased = CODE_ALIASES[rawCode] ?? rawCode;
    const parsed = FileErrorCode.safeParse(aliased);
    if (parsed.success) return parsed.data;
  }
  return codeFromStatus(status);
}

const MAX_MB = Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024);

/** Fixed copy per code and viewer; server message text is never shown. */
export function friendlyFileError(
  code: FileErrorCode,
  viewer: FileErrorViewer = {},
): FriendlyFileError {
  const copy = (title: string, description: string) => ({
    code,
    title,
    description,
  });
  switch (code) {
    case "UNAUTHORIZED":
      return copy(
        "Signed out",
        "You were signed out. Sign in again to open this file.",
      );
    case "FORBIDDEN":
      return copy("No access", "You don't have access to this file.");
    case "NOT_FOUND":
    case "GONE":
      return copy(
        "File removed",
        "This file was removed or is no longer shared with you.",
      );
    case "APPOINTMENT_TERMINAL":
      return copy(
        "Booking closed",
        "This booking was cancelled or closed, so its files are no longer available.",
      );
    case "STORAGE_MISSING":
      return copy(
        "File unavailable",
        viewer.isUploader
          ? "This file didn't finish saving. Upload it again."
          : "This file didn't finish saving. Ask the person who shared it to upload it again.",
      );
    case "STORAGE_UNAVAILABLE":
      return copy(
        "Files unavailable",
        "Files are temporarily unavailable. Try again in a moment.",
      );
    case "SUPERSEDED":
      return copy(
        "Newer version uploaded",
        viewer.role === "consultant"
          ? "The learner uploaded a newer version. Review that one instead."
          : "A newer version was uploaded. Refresh to see it.",
      );
    case "THREAD_IN_REVIEW":
      return copy(
        "Review in progress",
        "Your expert is reviewing this version. You can upload again once they respond.",
      );
    case "THREAD_CLOSED":
      return copy(
        "Document closed",
        "This document is closed: it was approved or not accepted.",
      );
    case "INVALID_THREAD_PARENT":
      return copy(
        "Version removed",
        "The version you're responding to was removed. Refresh and try again.",
      );
    case "VERSION_LIMIT_REACHED":
      return copy(
        "Version limit reached",
        `You've used all ${MAX_LEARNER_VERSIONS_PER_THREAD} versions for this document. Start a new document instead.`,
      );
    case "DOCUMENT_LIMIT_REACHED":
      return copy(
        "Document limit reached",
        `This booking already has ${MAX_DOCS_PER_APPOINTMENT} documents.`,
      );
    case "FILE_TOO_LARGE":
      return copy("File too large", `Files can be up to ${MAX_MB} MB.`);
    case "UNSUPPORTED_FILE_TYPE":
      return copy(
        "Unsupported file type",
        "Upload a PDF, Word document, image (JPG, PNG, GIF) or text file.",
      );
    case "RATE_LIMITED":
      return copy(
        "Too many requests",
        "Too many requests. Try again in a minute.",
      );
    case "NETWORK":
      return copy("Connection problem", "Check your connection and try again.");
    case "SERVER_ERROR":
      return copy("Something went wrong", "Something went wrong. Try again.");
  }
}

/** Reads a failed response's `code` (any body, even non-JSON) into fixed copy. */
export async function friendlyErrorFromResponse(
  res: Response,
  viewer?: FileErrorViewer,
): Promise<FriendlyFileError> {
  const raw: unknown = await res.json().catch(() => null);
  const parsed = FileApiErrorBodySchema.safeParse(raw);
  const code = resolveFileErrorCode(
    res.status,
    parsed.success ? parsed.data.code : undefined,
  );
  return friendlyFileError(code, viewer);
}

/** Thrown by client file actions so callers can toast `title` and `message`. */
export class FileActionError extends Error {
  readonly code: FileErrorCode;
  readonly title: string;

  constructor(friendly: FriendlyFileError) {
    super(friendly.description);
    this.name = "FileActionError";
    this.code = friendly.code;
    this.title = friendly.title;
  }
}
