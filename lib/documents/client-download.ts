import { z } from "zod";

import { getAppointmentDocumentUrl, getPlanMaterialUrl } from "./urls";
import {
  friendlyErrorFromResponse,
  friendlyFileError,
  type FileErrorViewer,
  type FriendlyFileError,
} from "./file-errors";

const SignedDownloadSchema = z.object({
  signedUrl: z.string().url(),
  originalName: z.string().optional(),
});

/**
 * Download preflight: fetches a fresh signed attachment link as JSON and saves
 * it through a detached anchor, so errors come back as copy and the tab stays put.
 */
async function downloadSignedFile(
  endpointUrl: string,
  viewer?: FileErrorViewer,
): Promise<FriendlyFileError | null> {
  const separator = endpointUrl.includes("?") ? "&" : "?";
  let res: Response;
  try {
    res = await fetch(`${endpointUrl}${separator}format=json`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return friendlyFileError("NETWORK", viewer);
  }
  if (!res.ok) return friendlyErrorFromResponse(res, viewer);

  const parsed = SignedDownloadSchema.safeParse(
    await res.json().catch(() => null),
  );
  if (!parsed.success) return friendlyFileError("SERVER_ERROR", viewer);

  const link = window.document.createElement("a");
  link.href = parsed.data.signedUrl;
  link.download = parsed.data.originalName ?? "";
  link.rel = "noopener noreferrer";
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  return null;
}

export function downloadAppointmentDocument(
  appointmentId: string,
  documentId: string,
  viewer?: FileErrorViewer,
): Promise<FriendlyFileError | null> {
  return downloadSignedFile(
    getAppointmentDocumentUrl(appointmentId, documentId, "attachment"),
    viewer,
  );
}

export function downloadPlanMaterial(
  materialId: string,
  viewer?: FileErrorViewer,
): Promise<FriendlyFileError | null> {
  return downloadSignedFile(
    getPlanMaterialUrl(materialId, "attachment"),
    viewer,
  );
}
