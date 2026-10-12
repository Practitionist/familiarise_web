import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "./file-errors";

/**
 * Client-side 2-phase presigned upload helper with XHR upload progress:
 * mints a single-use upload URL (`/upload-url`), PUTs bytes directly to Supabase Storage,
 * and commits metadata without hitting the 6 MB serverless body ceiling.
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
    throw new FileActionError(await friendlyErrorFromResponse(res));
  }
  return res;
}

async function tryPresignedDirectUpload(
  appointmentId: string,
  targetEndpoint: string,
  params: DirectUploadDocumentParams,
): Promise<Response | null> {
  const { file, description, responseToDocumentId, onProgress } = params;

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

        const commitRes = await fetch(targetEndpoint, {
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
        return ensureOkResponse(commitRes);
      }
      return null;
    }

    if (
      presignRes.status >= 400 &&
      presignRes.status < 500 &&
      presignRes.status !== 404
    ) {
      return ensureOkResponse(presignRes);
    }
    return null;
  } catch (err) {
    if (err instanceof Error && !err.message.includes("Storage upload")) {
      throw err;
    }
    return null;
  }
}

async function uploadMultipartFallback(
  targetEndpoint: string,
  params: DirectUploadDocumentParams,
): Promise<Response> {
  const formData = new FormData();
  formData.append("file", params.file);
  if (params.description?.trim()) {
    formData.append("description", params.description.trim());
  }
  if (params.responseToDocumentId) {
    formData.append("responseToDocumentId", params.responseToDocumentId);
  }

  const fallbackRes = await fetch(targetEndpoint, {
    method: "POST",
    body: formData,
  });
  return ensureOkResponse(fallbackRes);
}

export async function uploadAppointmentDocumentWithProgress(
  params: DirectUploadDocumentParams,
): Promise<Response> {
  const { appointmentId, role = "consultee", endpoint } = params;

  const targetEndpoint =
    endpoint ??
    (role === "consultant"
      ? `/api/appointments/${encodeURIComponent(appointmentId)}/documents/consultant`
      : `/api/appointments/${encodeURIComponent(appointmentId)}/documents`);

  try {
    if (typeof XMLHttpRequest !== "undefined") {
      const directRes = await tryPresignedDirectUpload(
        appointmentId,
        targetEndpoint,
        params,
      );
      if (directRes) return directRes;
    }
    return await uploadMultipartFallback(targetEndpoint, params);
  } catch (err) {
    if (err instanceof FileActionError) throw err;
    throw new FileActionError(
      friendlyFileError(err instanceof TypeError ? "NETWORK" : "SERVER_ERROR"),
    );
  }
}
