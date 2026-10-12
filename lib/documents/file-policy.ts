/**
 * The one upload policy for session documents and plan materials: allowed
 * types, the byte limit, and the copy and `accept` attribute built from them.
 * Client-safe: no server imports.
 */

interface AllowedFileType {
  mime: string;
  extensions: readonly string[];
}

const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = [
  { mime: "application/pdf", extensions: [".pdf"] },
  { mime: "application/msword", extensions: [".doc"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
  },
  { mime: "application/vnd.ms-excel", extensions: [".xls"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
  },
  { mime: "application/vnd.ms-powerpoint", extensions: [".ppt"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
  },
  { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { mime: "image/png", extensions: [".png"] },
  { mime: "image/gif", extensions: [".gif"] },
  { mime: "image/webp", extensions: [".webp"] },
  { mime: "text/plain", extensions: [".txt"] },
  { mime: "text/csv", extensions: [".csv"] },
];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / 1024 / 1024);

export const ALLOWED_FILE_MIME_TYPES: readonly string[] =
  ALLOWED_FILE_TYPES.map((t) => t.mime);

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_FILE_MIME_TYPES);

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map(
  ALLOWED_FILE_TYPES.flatMap((t) =>
    t.extensions.map((ext) => [ext, t.mime] as const),
  ),
);

/** `accept` attribute for every file picker that feeds an upload route. */
export const FILE_ACCEPT_ATTR = [...MIME_BY_EXTENSION.keys()].join(",");

export const ALLOWED_FILE_TYPES_LABEL =
  "PDF, Word, Excel, PowerPoint, image (JPG, PNG, GIF, WebP), text or CSV";

export const FILE_POLICY_HINT = `${ALLOWED_FILE_TYPES_LABEL} · up to ${MAX_FILE_MB} MB each`;

export type FilePolicyErrorCode =
  "FILE_MISSING" | "FILE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE";

export const FILE_POLICY_STATUS: Record<FilePolicyErrorCode, number> = {
  FILE_MISSING: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
};

export type FilePolicyResult =
  { ok: true; mimeType: string } | { ok: false; code: FilePolicyErrorCode };

function extensionOf(name: string | undefined): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : name.slice(dot).toLowerCase();
}

/**
 * Checks size and type; browsers that report no type (or a generic one) for
 * Office or CSV files are resolved from the extension.
 */
export function validateUploadFile(file: {
  size: number;
  type: string;
  name?: string;
}): FilePolicyResult {
  if (file.size <= 0) return { ok: false, code: "FILE_MISSING" };
  if (file.size > MAX_FILE_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (ALLOWED_MIME_SET.has(file.type)) {
    return { ok: true, mimeType: file.type };
  }
  const generic = file.type === "" || file.type === "application/octet-stream";
  const ext = extensionOf(file.name);
  const inferred = generic && ext ? MIME_BY_EXTENSION.get(ext) : undefined;
  return inferred
    ? { ok: true, mimeType: inferred }
    : { ok: false, code: "UNSUPPORTED_FILE_TYPE" };
}

/** A short type label ("PDF", "DOCX") from the file name, else the MIME subtype. */
export function fileTypeLabel(file: {
  originalName: string;
  mimeType: string;
}): string {
  const ext = extensionOf(file.originalName)?.slice(1).toUpperCase();
  return ext && ext.length <= 5
    ? ext
    : (file.mimeType.split("/").pop()?.toUpperCase() ?? "File");
}
