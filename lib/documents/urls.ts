/**
 * Canonical API URL builders for on-demand authenticated streaming/preview of
 * private Supabase Storage artifacts (`AppointmentDocument` and `PlanMaterial`).
 *
 * Raw Supabase signed URLs stored at upload time expire after 60 minutes;
 * UI links must always route through these authenticated endpoints.
 */

export function getAppointmentDocumentUrl(
  appointmentId: string,
  documentId: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  return `/api/appointments/${encodeURIComponent(appointmentId)}/documents/${encodeURIComponent(documentId)}/download?disposition=${disposition}`;
}

export function getPlanMaterialUrl(
  materialId: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  return `/api/plans/materials/${encodeURIComponent(materialId)}/download?disposition=${disposition}`;
}

/** Same-origin viewer tab: signs on every load and renders friendly errors. */
export function getDocumentViewerUrl(documentId: string): string {
  return `/files/documents/${encodeURIComponent(documentId)}`;
}

export function getMaterialViewerUrl(materialId: string): string {
  return `/files/materials/${encodeURIComponent(materialId)}`;
}

const NON_PREVIEWABLE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".csv",
]);

export function isPreviewableMimeType(
  mimeType: string | null | undefined,
  fileName?: string | null,
): boolean {
  if (!mimeType) return false;
  if (fileName) {
    const lowerName = fileName.trim().toLowerCase();
    const dotIdx = lowerName.lastIndexOf(".");
    if (
      dotIdx !== -1 &&
      NON_PREVIEWABLE_EXTENSIONS.has(lowerName.slice(dotIdx))
    ) {
      return false;
    }
  }
  return (
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType === "text/plain"
  );
}

/** Sanitizes an arbitrary user filename to printable safe ASCII fallback characters. */
export function sanitizeContentDispositionFilename(
  originalName: string,
): string {
  const cleaned = originalName.replace(/[^\x20-\x7E]|["\\/]/g, "_").trim();
  return cleaned || "document";
}

/** Builds an RFC 6266 UTF-8 safe `Content-Disposition` header with ASCII fallback. */
export function formatContentDisposition(
  disposition: "inline" | "attachment",
  originalName: string,
): string {
  const asciiFallback = sanitizeContentDispositionFilename(originalName);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}
