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

export function isPreviewableMimeType(
  mimeType: string | null | undefined,
): boolean {
  if (!mimeType) return false;
  return (
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType === "text/plain"
  );
}
