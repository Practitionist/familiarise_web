import { supabaseAdmin } from "@/lib/supabase-storage-core";
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/document-review";
import { sanitizeContentDispositionFilename } from "@/lib/documents/urls";

export type SignedUrlOutcome =
  | {
      ok: true;
      signedUrl: string;
    }
  | {
      ok: false;
      code: "STORAGE_CONFIG_ERROR" | "STORAGE_MISSING";
    };

/**
 * Verifies storage existence (`.info()` / `.exists()`) and mints a short-lived (60s)
 * presigned URL so previews stream directly from storage without buffering in Next.js.
 */
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
            ? sanitizeContentDispositionFilename(params.originalName)
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

const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // PE MZ
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x23, 0x21], // Shebang (#!)
];

const ZIP_MIME_FAMILY = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const OLE_MIME_FAMILY = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const TEXT_MIME_FAMILY = new Set(["text/plain", "text/csv", "text/markdown"]);

interface MagicRule {
  matches: (bytes: Uint8Array) => boolean;
  resolve: (claimedMime: string) => { valid: boolean; detectedMime: string };
}

const MAGIC_RULES: readonly MagicRule[] = [
  {
    matches: (b) => startsWithBytes(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
    resolve: (claimed) => ({
      valid: claimed === "application/pdf",
      detectedMime: "application/pdf",
    }),
  },
  {
    matches: (b) =>
      startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    resolve: (claimed) => ({
      valid: claimed === "image/png",
      detectedMime: "image/png",
    }),
  },
  {
    matches: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]),
    resolve: (claimed) => ({
      valid: claimed === "image/jpeg" || claimed === "image/jpg",
      detectedMime: "image/jpeg",
    }),
  },
  {
    matches: (b) =>
      startsWithBytes(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWithBytes(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    resolve: (claimed) => ({
      valid: claimed === "image/gif",
      detectedMime: "image/gif",
    }),
  },
  {
    matches: (b) =>
      b.length >= 12 &&
      startsWithBytes(b, [0x52, 0x49, 0x46, 0x46]) &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
    resolve: (claimed) => ({
      valid: claimed === "image/webp",
      detectedMime: "image/webp",
    }),
  },
  {
    matches: (b) => startsWithBytes(b, [0x50, 0x4b, 0x03, 0x04]),
    resolve: (claimed) => ({
      valid: ZIP_MIME_FAMILY.has(claimed),
      detectedMime: ZIP_MIME_FAMILY.has(claimed) ? claimed : "application/zip",
    }),
  },
  {
    matches: (b) =>
      startsWithBytes(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    resolve: (claimed) => ({
      valid: OLE_MIME_FAMILY.has(claimed),
      detectedMime: OLE_MIME_FAMILY.has(claimed)
        ? claimed
        : "application/msword",
    }),
  },
  {
    matches: (b) => startsWithBytes(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
    resolve: (claimed) => ({
      valid: claimed === "application/x-rar-compressed",
      detectedMime: "application/x-rar-compressed",
    }),
  },
];

/** Validates file header bytes against declared MIME type and rejects binary executables. */
function detectMagicMimeType(
  bytes: Uint8Array,
  claimedMime: string,
): { valid: boolean; detectedMime: string } {
  for (const execSig of EXECUTABLE_SIGNATURES) {
    if (startsWithBytes(bytes, execSig)) {
      return { valid: false, detectedMime: "application/x-executable" };
    }
  }

  for (const rule of MAGIC_RULES) {
    if (rule.matches(bytes)) {
      return rule.resolve(claimedMime);
    }
  }

  if (TEXT_MIME_FAMILY.has(claimedMime)) {
    const hasNul = bytes.includes(0x00);
    return {
      valid: !hasNul,
      detectedMime: hasNul ? "application/octet-stream" : claimedMime,
    };
  }

  return { valid: false, detectedMime: "application/octet-stream" };
}

/**
 * Verifies a direct-uploaded storage object via metadata + 4 KB `Range: bytes=0-4095`
 * magic-byte check without buffering the full object; purges storage immediately on violation.
 */
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
  const headerBytes = new Uint8Array(ab.slice(0, 4096));

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
  const fileName = segments.at(-1) ?? params.storagePath;

  return {
    ok: true,
    fileName,
    fileSize: actualSize,
    mimeType: check.detectedMime,
    fileUrl: signedData.signedUrl,
  };
}
