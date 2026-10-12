import { z } from "zod";

import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "./file-errors";
import { validateUploadFile } from "./file-policy";

/**
 * Browser side of presign-then-commit: checks the file policy before any
 * request, PUTs the bytes straight to storage with progress, then commits.
 * Every failure is thrown as a FileActionError carrying fixed copy.
 */

const PresignSchema = z.object({
  uploadUrl: z.string().url(),
  storagePath: z.string().min(1),
  mimeType: z.string().min(1),
});

export interface UploadedObject {
  storagePath: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
}

class StorageUploadError extends Error {
  constructor(readonly status: number) {
    super(`Storage upload failed (${status})`);
    this.name = "StorageUploadError";
  }
}

/** PUTs a file to a signed upload URL, reporting progress. */
export function putFileWithProgress(
  uploadUrl: string,
  file: File,
  mimeType: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new StorageUploadError(xhr.status));
      }
    };
    xhr.onerror = () => reject(new TypeError("Network error"));
    xhr.send(file);
  });
}

/** Any upload failure as fixed copy. */
export function asFileActionError(error: unknown): FileActionError {
  if (error instanceof FileActionError) return error;
  if (error instanceof StorageUploadError) {
    return new FileActionError(
      friendlyFileError(
        error.status === 413 ? "FILE_TOO_LARGE" : "STORAGE_UNAVAILABLE",
      ),
    );
  }
  return new FileActionError(
    friendlyFileError(error instanceof TypeError ? "NETWORK" : "SERVER_ERROR"),
  );
}

/** POSTs JSON; a failure is thrown as fixed copy. */
export async function postJson(
  url: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new FileActionError(await friendlyErrorFromResponse(res));
  return res;
}

/** Presigns and uploads one file for a booking; the caller commits it. */
export async function uploadBookingFile(params: {
  appointmentId: string;
  file: File;
  parentDocumentId?: string | null;
  onProgress?: (percent: number) => void;
}): Promise<UploadedObject> {
  const { appointmentId, file } = params;
  try {
    const policy = validateUploadFile(file);
    if (!policy.ok) throw new FileActionError(friendlyFileError(policy.code));

    const presignRes = await postJson(
      `/api/appointments/${encodeURIComponent(appointmentId)}/documents/upload-url`,
      {
        originalName: file.name,
        mimeType: policy.mimeType,
        fileSize: file.size,
        parentDocumentId: params.parentDocumentId ?? null,
      },
    );
    const presign = PresignSchema.safeParse(await presignRes.json());
    if (!presign.success) {
      throw new FileActionError(friendlyFileError("SERVER_ERROR"));
    }
    await putFileWithProgress(
      presign.data.uploadUrl,
      file,
      presign.data.mimeType,
      params.onProgress,
    );
    return {
      storagePath: presign.data.storagePath,
      originalName: file.name,
      mimeType: presign.data.mimeType,
      fileSize: file.size,
    };
  } catch (error) {
    throw asFileActionError(error);
  }
}

/** Uploads and commits a new document, a new learner version or an expert's shared file. */
export async function uploadBookingDocument(params: {
  appointmentId: string;
  file: File;
  parentDocumentId?: string | null;
  description?: string;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  const uploaded = await uploadBookingFile(params);
  try {
    await postJson(
      `/api/appointments/${encodeURIComponent(params.appointmentId)}/documents`,
      {
        ...uploaded,
        parentDocumentId: params.parentDocumentId ?? null,
        description: params.description?.trim() || null,
      },
    );
  } catch (error) {
    throw asFileActionError(error);
  }
}
