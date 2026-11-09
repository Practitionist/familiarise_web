/**
 * Why an uploaded product file was rejected, in the creator's words. The
 * stored rejectReason is `CODE` or `CODE:detail` (the matched marker, entry
 * name or ratio); pure, so the editor and the routes share it.
 */

const ARCHIVE_DAMAGED =
  "The archive's structure is damaged or unusual. Re-create it with a standard ZIP tool and upload it again.";

export const ASSET_REJECT_MESSAGES: Record<string, string> = {
  UNSUPPORTED_FILE_TYPE:
    "This file type isn't allowed. Upload one of the supported formats.",
  SIZE_MISMATCH: "The upload didn't arrive complete. Upload the file again.",
  EXECUTABLE:
    "Programs and scripts can't be sold as product files. Upload a document or media file instead.",
  POLYGLOT:
    "This file contains scripts or web code, which aren't allowed. Export a plain copy (for a PDF, print it to PDF) and upload it again.",
  SIGNATURE_MISMATCH:
    "The file's contents don't match its extension. Re-export it in the right format and upload it again.",
  ZIP_NOT_A_ZIP:
    "This isn't a readable ZIP file. Re-create the archive and upload it again.",
  ZIP_EOCD_AMBIGUOUS: ARCHIVE_DAMAGED,
  ZIP_ZIP64_INCONSISTENT: ARCHIVE_DAMAGED,
  ZIP_CENTRAL_DIRECTORY_CORRUPT: ARCHIVE_DAMAGED,
  ZIP_MULTI_DISK:
    "Split (multi-part) archives aren't supported. Combine it into one ZIP and upload it again.",
  ZIP_TOO_MANY_ENTRIES:
    "The archive holds more than 1,000 files. Split it into smaller ZIPs.",
  ZIP_TOO_LARGE_UNCOMPRESSED:
    "The archive unpacks to more than 500 MB. Split it into smaller ZIPs.",
  ZIP_COMPRESSION_RATIO:
    "A file inside compresses far more than real content does, like a ZIP bomb. Remove it and upload again.",
  ZIP_ENCRYPTED_ENTRY:
    "Password-protected archives can't be checked. Remove the password and upload it again.",
  ZIP_UNSAFE_PATH:
    "A file inside has an unsafe path, such as ../ or a drive letter. Rename it and re-create the archive.",
  ZIP_UNICODE_PATH_INVALID:
    "A file name inside the archive is stored inconsistently. Re-create the archive with a standard ZIP tool.",
  ZIP_SYMLINK_ENTRY:
    "Archives can't contain shortcuts (symlinks). Replace them with the real files.",
  ZIP_NESTED_ARCHIVE:
    "Archives inside the ZIP aren't allowed. Unpack them into the main archive.",
  ZIP_EXECUTABLE_ENTRY:
    "The archive contains a program or script, which isn't allowed. Remove it and upload again.",
  ZIP_OFFICE_MACRO:
    "This document contains macros, which aren't allowed. Save a copy without macros (for example as a plain .docx, .xlsx or .pptx) and upload it again.",
  ZIP_EMBEDDED_OBJECT:
    "This document contains embedded objects (OLE or ActiveX), which aren't allowed. Remove them or paste the content as plain text or an image, then upload it again.",
  ZIP_EMPTY_ARCHIVE:
    "This archive has no files in it. Add the files you want to sell and zip them again.",
  ZIP_UNLISTED_DATA:
    "The archive holds data its file list doesn't account for, which can hide a file. Re-create it with a standard ZIP tool.",
  ZIP_EMBEDDED_ZIP_RECORD:
    "A file inside the archive was stored in a way that can hide another file, and its contents look like part of a ZIP. Re-zip the files on your computer and upload the new archive.",
  ZIP_DEEP_SCAN_TOO_LARGE:
    "This archive was made by a tool that streams files, and it's too large for us to check that way. Re-zip the files on your computer (Compress, or zip -r) or split them into smaller archives, then upload again.",
  ZIP_ENTRY_DATA_MISMATCH:
    "A file inside the archive doesn't match the size or checksum the archive records for it. Re-zip the files on your computer and upload the new archive.",
  ZIP_UNVERIFIABLE_ENTRY:
    "A file inside the archive uses a streaming compression method we can't check. Re-zip the files on your computer (Compress, or zip -r) and upload the new archive.",
  ZIP_LOCAL_HEADER_MISMATCH:
    "A file inside the archive is described differently in two places, which can hide what it really is. Re-create the archive with a standard ZIP tool.",
  NEWER_VERSION_EXISTS: "A newer version of this file was already uploaded.",
  LINEAGE_DELETED:
    "The file this replaced was removed, so this version was discarded.",
  REMOVED: "You removed this file.",
  ABANDONED: "The upload never finished. Upload the file again.",
};

const FALLBACK = "This file failed our checks. Export it again and re-upload.";
const MAX_DETAIL = 200;

/** The stored form: the code, plus a single-line detail when there is one. */
export function formatRejectReason(code: string, detail?: string): string {
  const clean = detail?.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return clean ? `${code}:${clean}` : code;
}

export interface RejectReasonView {
  message: string;
  code: string;
  detail: string | null;
}

export function describeRejectReason(stored: string | null): RejectReasonView {
  const raw = stored ?? "";
  const at = raw.indexOf(":");
  const code = at === -1 ? raw : raw.slice(0, at);
  const detail = at === -1 ? null : raw.slice(at + 1) || null;
  return { message: ASSET_REJECT_MESSAGES[code] ?? FALLBACK, code, detail };
}
