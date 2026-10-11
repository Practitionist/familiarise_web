import { supabaseAdmin } from "@/lib/supabase-storage-core";
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/document-review";

export type SignedUrlOutcome =
  | {
      ok: true;
      signedUrl: string;
    }
  | {
      ok: false;
      code: "STORAGE_CONFIG_ERROR" | "STORAGE_MISSING";
    };

function sanitizeDownloadFileName(originalName: string): string {
  const cleaned = originalName.replace(/[^\x20-\x7E]|["\\/]/g, "_").trim();
  return cleaned || "document";
}

export async function createSignedStorageUrl(params: {
  bucket: string;
  storagePath: string;
  originalName: string;
  disposition: "inline" | "attachment";
  expiresInSeconds?: number;
}): Promise<SignedUrlOutcome> {
  if (!supabaseAdmin) {
    return { ok: false, code: "STORAGE_CONFIG_ERROR" };
  }

  const bucketApi = supabaseAdmin.storage.from(params.bucket);

  // Verify the storage object actually exists before minting a signed JWT.
  if (typeof bucketApi.info === "function") {
    const { data: infoData, error: infoError } = await bucketApi.info(
      params.storagePath,
    );
    if (infoError || !infoData) {
      return { ok: false, code: "STORAGE_MISSING" };
    }
  } else if (typeof bucketApi.exists === "function") {
    const { data: existsData, error: existsError } = await bucketApi.exists(
      params.storagePath,
    );
    if (existsError || !existsData) {
      return { ok: false, code: "STORAGE_MISSING" };
    }
  }

  const { data: signedData, error: signedError } =
    await bucketApi.createSignedUrl(
      params.storagePath,
      params.expiresInSeconds ?? 60,
      {
        download:
          params.disposition === "attachment"
            ? sanitizeDownloadFileName(params.originalName)
            : false,
      },
    );

  if (signedError || !signedData?.signedUrl) {
    return { ok: false, code: "STORAGE_MISSING" };
  }

  return { ok: true, signedUrl: signedData.signedUrl };
}

function startsWithBytes(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

export function detectMagicMimeType(
  bytes: Uint8Array,
  claimedMime: string,
): { valid: boolean; detectedMime: string } {
  // Reject executable binaries unconditionally (PE MZ, ELF, Mach-O, shebang)
  if (
    startsWithBytes(bytes, [0x4d, 0x5a]) ||
    startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWithBytes(bytes, [0x23, 0x21])
  ) {
    return { valid: false, detectedMime: "application/x-executable" };
  }

  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return {
      valid: claimedMime === "application/pdf",
      detectedMime: "application/pdf",
    };
  }

  if (
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return {
      valid: claimedMime === "image/png",
      detectedMime: "image/png",
    };
  }

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return {
      valid: claimedMime === "image/jpeg" || claimedMime === "image/jpg",
      detectedMime: "image/jpeg",
    };
  }

  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return {
      valid: claimedMime === "image/gif",
      detectedMime: "image/gif",
    };
  }

  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return {
      valid: claimedMime === "image/webp",
      detectedMime: "image/webp",
    };
  }

  // PK\x03\x04 ZIP / OOXML (.docx, .xlsx, .pptx, .zip)
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zipFamily = new Set([
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]);
    return {
      valid: zipFamily.has(claimedMime),
      detectedMime: zipFamily.has(claimedMime)
        ? claimedMime
        : "application/zip",
    };
  }

  // OLE2 Compound Binary (.doc, .xls, .ppt)
  if (
    startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  ) {
    const oleFamily = new Set([
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
    ]);
    return {
      valid: oleFamily.has(claimedMime),
      detectedMime: oleFamily.has(claimedMime)
        ? claimedMime
        : "application/msword",
    };
  }

  // RAR archive
  if (startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
    return {
      valid: claimedMime === "application/x-rar-compressed",
      detectedMime: "application/x-rar-compressed",
    };
  }

  // Plain text / CSV / Markdown: ensure no NUL bytes in first 4KB
  if (
    claimedMime === "text/plain" ||
    claimedMime === "text/csv" ||
    claimedMime === "text/markdown"
  ) {
    const hasNul = bytes.some((b) => b === 0x00);
    return {
      valid: !hasNul,
      detectedMime: hasNul ? "application/octet-stream" : claimedMime,
    };
  }

  return { valid: false, detectedMime: "application/octet-stream" };
}

export async function verifyDirectUploadedObject(params: {
  bucket: string;
  storagePath: string;
  requiredPrefix: string;
  claimedMimeType: string;
  maxBytes?: number;
}): Promise<
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileUrl: string;
    }
  | {
      ok: false;
      code:
        | "INVALID_STORAGE_PATH"
        | "STORAGE_CONFIG_ERROR"
        | "STORAGE_MISSING"
        | "FILE_TOO_LARGE"
        | "UNSUPPORTED_FILE_TYPE";
      message: string;
    }
> {
  if (!supabaseAdmin) {
    return {
      ok: false,
      code: "STORAGE_CONFIG_ERROR",
      message: "Document storage is not configured on the server.",
    };
  }

  const maxBytes = params.maxBytes ?? MAX_DOCUMENT_BYTES;
  if (
    !params.storagePath.startsWith(params.requiredPrefix) ||
    params.storagePath.includes("..")
  ) {
    return {
      ok: false,
      code: "INVALID_STORAGE_PATH",
      message: "Uploaded file path does not match the authorized upload slot.",
    };
  }

  const bucketApi = supabaseAdmin.storage.from(params.bucket);
  const purge = async () => {
    try {
      await bucketApi.remove([params.storagePath]);
    } catch {
      // Best-effort immediate orphan cleanup
    }
  };

  let actualSize = 0;
  if (typeof bucketApi.info === "function") {
    const { data: infoData, error: infoError } = await bucketApi.info(
      params.storagePath,
    );
    if (infoError || !infoData) {
      return {
        ok: false,
        code: "STORAGE_MISSING",
        message: "Uploaded object was not found in storage.",
      };
    }
    const metaSize =
      typeof infoData.size === "number"
        ? infoData.size
        : Number(infoData.metadata?.size ?? 0);
    actualSize = Number.isFinite(metaSize) ? metaSize : 0;
  }

  if (actualSize <= 0 || actualSize > maxBytes) {
    await purge();
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `Uploaded file size must be between 1 byte and ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    };
  }

  // Fetch first 4096 bytes via signed Range request to inspect magic bytes without loading full object
  const { data: signedData, error: signErr } = await bucketApi.createSignedUrl(
    params.storagePath,
    60,
  );
  if (signErr || !signedData?.signedUrl) {
    await purge();
    return {
      ok: false,
      code: "STORAGE_MISSING",
      message: "Unable to sign uploaded object for verification.",
    };
  }

  let headerBytes = new Uint8Array(0);
  const rangeRes = await fetch(signedData.signedUrl, {
    headers: { Range: "bytes=0-4095" },
  });
  if (!rangeRes.ok) {
    await purge();
    return {
      ok: false,
      code: "STORAGE_MISSING",
      message: "Uploaded object could not be read for verification.",
    };
  }
  const ab = await rangeRes.arrayBuffer();
  headerBytes = new Uint8Array(ab.slice(0, 4096));

  const check = detectMagicMimeType(headerBytes, params.claimedMimeType);
  if (!check.valid) {
    await purge();
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "Uploaded file contents do not match the declared file type.",
    };
  }

  const segments = params.storagePath.split("/");
  const fileName = segments[segments.length - 1] ?? params.storagePath;

  return {
    ok: true,
    fileName,
    fileSize: actualSize,
    mimeType: check.detectedMime,
    fileUrl: signedData.signedUrl,
  };
}
