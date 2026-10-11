/**
 * Client-side 2-phase presigned upload helper with XHR upload progress.
 *
 * Phase 1: `POST /api/appointments/[appointmentId]/documents/upload-url` mints a single-use
 *          signed upload URL for private Supabase Storage bucket `documents`.
 * Phase 2: Direct PUT to storage with XHR progress tracking, followed by lightweight metadata POST.
 *          Falls back seamlessly to multipart FormData upload when running in environments/tests
 *          where direct storage PUT URLs are not provisioned.
 */

export interface DirectUploadDocumentParams {
  appointmentId: string;
  file: File;
  role?: "consultee" | "consultant";
  endpoint?: string;
  description?: string;
  responseToDocumentId?: string;
  onProgress?: (percent: number) => void;
}

function putFileWithProgress(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );

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
        reject(new Error(`Storage upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Network error while uploading file to storage"));
    };

    xhr.send(file);
  });
}

async function ensureOkResponse(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || body?.error || "Failed to upload file");
  }
  return res;
}

export async function uploadAppointmentDocumentWithProgress(
  params: DirectUploadDocumentParams,
): Promise<Response> {
  const {
    appointmentId,
    file,
    role = "consultee",
    endpoint,
    description,
    responseToDocumentId,
    onProgress,
  } = params;

  const targetEndpoint =
    endpoint ??
    (role === "consultant"
      ? `/api/appointments/${encodeURIComponent(appointmentId)}/documents/consultant`
      : `/api/appointments/${encodeURIComponent(appointmentId)}/documents`);

  if (typeof XMLHttpRequest !== "undefined") {
    try {
      const presignRes = await fetch(
        `/api/appointments/${encodeURIComponent(appointmentId)}/documents/upload-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originalName: file.name,
            mimeType: file.type,
            fileSize: file.size,
            responseToDocumentId: responseToDocumentId || undefined,
          }),
        },
      );

      if (presignRes.ok) {
        const presignJson = (await presignRes.json()) as {
          uploadUrl?: string;
          storagePath?: string;
        };
        if (presignJson.uploadUrl && presignJson.storagePath) {
          await putFileWithProgress(presignJson.uploadUrl, file, onProgress);

          const postRes = await fetch(targetEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storagePath: presignJson.storagePath,
              originalName: file.name,
              mimeType: file.type,
              fileSize: file.size,
              description: description?.trim() || undefined,
              responseToDocumentId: responseToDocumentId || undefined,
            }),
          });
          return ensureOkResponse(postRes);
        }
      } else if (
        presignRes.status >= 400 &&
        presignRes.status < 500 &&
        presignRes.status !== 404
      ) {
        return ensureOkResponse(presignRes);
      }
    } catch (err) {
      if (err instanceof Error && !err.message.includes("Storage upload")) {
        throw err;
      }
    }
  }

  const formData = new FormData();
  formData.append("file", file);
  if (description?.trim()) {
    formData.append("description", description.trim());
  }
  if (responseToDocumentId) {
    formData.append("responseToDocumentId", responseToDocumentId);
  }

  const fallbackRes = await fetch(targetEndpoint, {
    method: "POST",
    body: formData,
  });
  return ensureOkResponse(fallbackRes);
}
