import { z } from "zod";

import {
  MAX_DOCS_PER_APPOINTMENT,
  MAX_LEARNER_VERSIONS_PER_THREAD,
} from "./document-review";
import { DOCUMENT_UPLOAD_WINDOW_DAYS } from "./document-dates";
import { ALLOWED_FILE_TYPES_LABEL, MAX_FILE_MB } from "./file-policy";

/**
 * The one error vocabulary for document, material and recording routes: the
 * code, its HTTP status, and the fixed copy the UI shows. Server `message`
 * text is never shown. Client-safe.
 */

export const FileErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "GONE",
  "INVALID_INPUT",
  "APPOINTMENT_TERMINAL",
  "BOOKING_NOT_CONFIRMED",
  "UPLOAD_WINDOW_CLOSED",
  "STORAGE_MISSING",
  "STORAGE_UNAVAILABLE",
  "SUPERSEDED",
  "INVALID_REVIEW_TRANSITION",
  "THREAD_CLOSED",
  "THREAD_IN_REVIEW",
  "INVALID_THREAD_PARENT",
  "VERSION_LIMIT_REACHED",
  "DOCUMENT_LIMIT_REACHED",
  "MATERIAL_LIMIT_REACHED",
  "DOCUMENT_NOT_DELETABLE",
  "REMOVAL_ALREADY_REQUESTED",
  "FILE_MISSING",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "OWN_RECORDING_AVAILABLE",
  "LATE_JOIN_HIDDEN",
  "RATE_LIMITED",
  "NETWORK",
  "SERVER_ERROR",
]);
export type FileErrorCode = z.infer<typeof FileErrorCode>;

/** The body every file route returns on failure. */
export const FileApiErrorSchema = z.object({
  code: FileErrorCode,
  message: z.string(),
  closedAt: z.string().datetime().optional(),
});
export type FileApiError = z.infer<typeof FileApiErrorSchema>;

export const FILE_ERROR_STATUS: Record<
  Exclude<FileErrorCode, "NETWORK">,
  number
> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 410,
  INVALID_INPUT: 400,
  APPOINTMENT_TERMINAL: 403,
  BOOKING_NOT_CONFIRMED: 409,
  UPLOAD_WINDOW_CLOSED: 409,
  STORAGE_MISSING: 404,
  STORAGE_UNAVAILABLE: 503,
  SUPERSEDED: 409,
  INVALID_REVIEW_TRANSITION: 409,
  THREAD_CLOSED: 409,
  THREAD_IN_REVIEW: 409,
  INVALID_THREAD_PARENT: 404,
  VERSION_LIMIT_REACHED: 409,
  DOCUMENT_LIMIT_REACHED: 409,
  MATERIAL_LIMIT_REACHED: 409,
  DOCUMENT_NOT_DELETABLE: 409,
  REMOVAL_ALREADY_REQUESTED: 409,
  FILE_MISSING: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  OWN_RECORDING_AVAILABLE: 403,
  LATE_JOIN_HIDDEN: 403,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
};

export interface FriendlyFileError {
  code: FileErrorCode;
  title: string;
  description: string;
}

export interface FileErrorViewer {
  /** Whether the viewer uploaded the file the error is about. */
  isUploader?: boolean;
  role?: "consultee" | "consultant";
  /** ISO date the upload window closed, when the server sent one. */
  closedAt?: string;
}

const LOOSE_ERROR_BODY = z.object({
  code: z.string().optional(),
  closedAt: z.string().optional(),
});

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
  const parsed = FileErrorCode.safeParse(rawCode);
  return parsed.success ? parsed.data : codeFromStatus(status);
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dayFormat.format(date);
}

/** Fixed copy per code and viewer. */
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
      return copy("File removed", "This file was removed.");
    case "INVALID_INPUT":
      return copy("Couldn't send that", "Check the details and try again.");
    case "APPOINTMENT_TERMINAL":
      return copy(
        "Booking cancelled",
        "This booking was cancelled, so its files are read-only.",
      );
    case "BOOKING_NOT_CONFIRMED":
      return copy(
        "Not confirmed yet",
        "You can share files once the booking is confirmed.",
      );
    case "UPLOAD_WINDOW_CLOSED": {
      const day = formatDay(viewer.closedAt);
      return copy(
        "Uploads closed",
        day
          ? `Uploads closed on ${day}, ${DOCUMENT_UPLOAD_WINDOW_DAYS} days after the last session.`
          : `Uploads close ${DOCUMENT_UPLOAD_WINDOW_DAYS} days after the last session.`,
      );
    }
    case "STORAGE_MISSING":
      return copy(
        "File unavailable",
        viewer.isUploader
          ? "This file didn't finish saving. Upload it again."
          : viewer.role === "consultant"
            ? "This file didn't finish saving. Ask the learner to upload it again."
            : "This file didn't finish saving. Ask your expert to upload it again.",
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
    case "INVALID_REVIEW_TRANSITION":
      return copy(
        "Review already finished",
        "This document's review has already finished. Refresh to see it.",
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
    case "MATERIAL_LIMIT_REACHED":
      return copy(
        "File limit reached",
        "This offering already has the most files it can hold. Remove one first.",
      );
    case "DOCUMENT_NOT_DELETABLE":
      return copy(
        "Can't remove this",
        "Only the latest version that is still waiting for review can be withdrawn.",
      );
    case "REMOVAL_ALREADY_REQUESTED":
      return copy(
        "Removal already requested",
        "You already asked for this to be removed. Support will reply in your session's support chat.",
      );
    case "FILE_MISSING":
      return copy("No file chosen", "Choose a file to upload.");
    case "FILE_TOO_LARGE":
      return copy("File too large", `Files can be up to ${MAX_FILE_MB} MB.`);
    case "UNSUPPORTED_FILE_TYPE":
      return copy(
        "Unsupported file type",
        `Upload a ${ALLOWED_FILE_TYPES_LABEL} file.`,
      );
    case "OWN_RECORDING_AVAILABLE":
      return copy(
        "Your batch has this session",
        "Watch your own batch's recording of this session.",
      );
    case "LATE_JOIN_HIDDEN":
      return copy(
        "Before you joined",
        "This session took place before you joined.",
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
  viewer: FileErrorViewer = {},
): Promise<FriendlyFileError> {
  const raw: unknown = await res.json().catch(() => null);
  const parsed = LOOSE_ERROR_BODY.safeParse(raw);
  const body = parsed.success ? parsed.data : {};
  const code = resolveFileErrorCode(res.status, body.code);
  return friendlyFileError(code, {
    ...viewer,
    closedAt: viewer.closedAt ?? body.closedAt,
  });
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

/** Fixed, neutral server text per code; logs and other clients read it, the UI never does. */
export const FILE_ERROR_MESSAGE: Record<
  Exclude<FileErrorCode, "NETWORK">,
  string
> = {
  UNAUTHORIZED: "Sign in required.",
  FORBIDDEN: "Not allowed.",
  NOT_FOUND: "Not found.",
  GONE: "No longer available.",
  INVALID_INPUT: "Invalid request.",
  APPOINTMENT_TERMINAL: "The booking is closed.",
  BOOKING_NOT_CONFIRMED: "The booking is not confirmed yet.",
  UPLOAD_WINDOW_CLOSED: "The upload window has closed.",
  STORAGE_MISSING: "The stored file is missing.",
  STORAGE_UNAVAILABLE: "File storage is unavailable.",
  SUPERSEDED: "A newer version exists.",
  INVALID_REVIEW_TRANSITION: "That review change is not allowed.",
  THREAD_CLOSED: "The document is closed.",
  THREAD_IN_REVIEW: "The document is in review.",
  INVALID_THREAD_PARENT: "The parent version was not found.",
  VERSION_LIMIT_REACHED: "The version limit is reached.",
  DOCUMENT_LIMIT_REACHED: "The document limit is reached.",
  MATERIAL_LIMIT_REACHED: "The material limit is reached.",
  DOCUMENT_NOT_DELETABLE: "The document cannot be removed.",
  REMOVAL_ALREADY_REQUESTED: "Removal was already requested.",
  FILE_MISSING: "No file was provided.",
  FILE_TOO_LARGE: "The file is too large.",
  UNSUPPORTED_FILE_TYPE: "The file type is not supported.",
  OWN_RECORDING_AVAILABLE: "The viewer's own recording is available.",
  LATE_JOIN_HIDDEN: "The session predates the viewer's seat.",
  RATE_LIMITED: "Too many requests.",
  SERVER_ERROR: "Something went wrong.",
};
