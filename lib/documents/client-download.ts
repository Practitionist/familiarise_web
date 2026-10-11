import { z } from "zod";
import { getAppointmentDocumentUrl, getPlanMaterialUrl } from "./urls";

const SignedUrlResponseSchema = z.object({
  signedUrl: z.string().url().optional(),
  originalName: z.string().optional(),
  mimeType: z.string().nullable().optional(),
  previewable: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

export interface FriendlyFileError {
  title: string;
  description: string;
}

export function resolveFriendlyFileError(
  status: number,
  code?: string,
  serverMessage?: string,
): FriendlyFileError {
  if (code === "STORAGE_MISSING" || status === 404) {
    return {
      title: "File unavailable",
      description:
        serverMessage ||
        "This file is missing from storage or has been removed. Upload a replacement version to restore access.",
    };
  }
  if (code === "APPOINTMENT_TERMINAL" || status === 403) {
    return {
      title: "Access unavailable",
      description:
        serverMessage ||
        "Files from closed, cancelled, or unpaid sessions are no longer accessible.",
    };
  }
  if (code === "UNAUTHORIZED" || status === 401) {
    return {
      title: "Sign in required",
      description:
        "Your session expired. Please sign in again to access files.",
    };
  }
  return {
    title: "Unable to open file",
    description:
      serverMessage ||
      "We couldn't generate a secure download link right now. Please try again in a moment.",
  };
}

function triggerBrowserNavigation(
  signedUrl: string,
  disposition: "inline" | "attachment",
  fallbackName?: string,
): void {
  if (disposition === "inline") {
    const opened = window.open(signedUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.assign(signedUrl);
    }
    return;
  }

  const link = window.document.createElement("a");
  link.href = signedUrl;
  if (fallbackName) {
    link.download = fallbackName;
  }
  link.rel = "noopener noreferrer";
  window.document.body.appendChild(link);
  link.click();
  window.document.body.removeChild(link);
}

/**
 * Resolves a short-lived signed storage URL via `?format=json` before navigating
 * so missing files or closed bookings surface friendly UI feedback instead of raw JSON tabs.
 */
export async function resolveAndOpenSignedFile(
  endpointUrl: string,
  options: {
    disposition: "inline" | "attachment";
    fallbackName?: string;
    onError: (err: FriendlyFileError) => void;
  },
): Promise<boolean> {
  const { disposition, fallbackName, onError } = options;
  const separator = endpointUrl.includes("?") ? "&" : "?";
  const jsonUrl = `${endpointUrl}${separator}format=json`;

  try {
    const res = await fetch(jsonUrl, {
      headers: { Accept: "application/json" },
    });
    const raw = await res.json().catch(() => ({}));
    const parsed = SignedUrlResponseSchema.safeParse(raw);
    const payload = parsed.success ? parsed.data : {};

    if (!res.ok || !payload.signedUrl) {
      onError(
        resolveFriendlyFileError(res.status, payload.code, payload.message),
      );
      return false;
    }

    triggerBrowserNavigation(
      payload.signedUrl,
      disposition,
      payload.originalName ?? fallbackName,
    );
    return true;
  } catch {
    onError({
      title: "Connection interrupted",
      description:
        "Unable to reach document storage right now. Check your connection and try again.",
    });
    return false;
  }
}

export function openAppointmentDocument(
  appointmentId: string,
  documentId: string,
  disposition: "inline" | "attachment",
  onError: (err: FriendlyFileError) => void,
  fallbackName?: string,
): Promise<boolean> {
  return resolveAndOpenSignedFile(
    getAppointmentDocumentUrl(appointmentId, documentId, disposition),
    { disposition, fallbackName, onError },
  );
}

export function openPlanMaterial(
  materialId: string,
  disposition: "inline" | "attachment",
  onError: (err: FriendlyFileError) => void,
  fallbackName?: string,
): Promise<boolean> {
  return resolveAndOpenSignedFile(getPlanMaterialUrl(materialId, disposition), {
    disposition,
    fallbackName,
    onError,
  });
}
