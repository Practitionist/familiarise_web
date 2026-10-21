/** Support evidence uploads: the one allowlist shared by the API, bucket and file picker. */
export const SUPPORT_EVIDENCE_BUCKET = "support-attachments";

export const SUPPORT_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type SupportAttachmentMimeType =
  (typeof SUPPORT_ATTACHMENT_MIME_TYPES)[number];

export const SUPPORT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Value for an `<input type="file" accept>` that matches the server allowlist. */
export const SUPPORT_ATTACHMENT_ACCEPT = [
  ...SUPPORT_ATTACHMENT_MIME_TYPES,
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".txt",
  ".docx",
].join(",");

/** Bytes of an object's head read to confirm its declared type. */
export const SUPPORT_ATTACHMENT_SNIFF_BYTES = 512;

const startsWith = (head: Uint8Array, signature: readonly number[], at = 0) =>
  head.length >= at + signature.length &&
  signature.every((byte, index) => head[at + index] === byte);

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

/** Plain text carries no NUL or non-whitespace C0 control bytes. */
function looksLikeText(head: Uint8Array): boolean {
  return head.every(
    (byte) => byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d,
  );
}

/**
 * Whether the object's first bytes match its declared type. Clients choose the
 * stored Content-Type, so this is the only server check of what the file is.
 */
export function headMatchesMimeType(
  head: Uint8Array,
  mimeType: SupportAttachmentMimeType,
): boolean {
  switch (mimeType) {
    case "application/pdf":
      return startsWith(head, ascii("%PDF-"));
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return (
        startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)
      );
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case "text/plain":
      return head.length > 0 && looksLikeText(head);
  }
}
