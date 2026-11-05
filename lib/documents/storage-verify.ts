import { supabaseAdmin } from "@/lib/supabase-storage-core";
import { MAX_FILE_BYTES } from "@/lib/documents/file-policy";
import { sanitizeContentDispositionFilename } from "@/lib/documents/urls";

type StorageObjectProblem = "STORAGE_MISSING" | "STORAGE_UNAVAILABLE";

export type SignedUrlOutcome =
  { ok: true; signedUrl: string } | { ok: false; code: StorageObjectProblem };

/** A 404-class storage answer means the object is gone; anything else is transient. */
function storageProblem(
  error: { status?: number; statusCode?: string } | null,
): StorageObjectProblem {
  const missing =
    error?.status === 404 ||
    error?.statusCode === "404" ||
    error?.statusCode === "NoSuchKey";
  return missing ? "STORAGE_MISSING" : "STORAGE_UNAVAILABLE";
}

/** Confirms the object exists and signs a short-lived link to it. */
export async function createSignedStorageUrl(params: {
  bucket: string;
  storagePath: string;
  originalName: string;
  disposition: "inline" | "attachment";
  expiresInSeconds: number;
}): Promise<SignedUrlOutcome> {
  if (!supabaseAdmin) return { ok: false, code: "STORAGE_UNAVAILABLE" };

  const bucketApi = supabaseAdmin.storage.from(params.bucket);
  const { data: info, error: infoError } = await bucketApi.info(
    params.storagePath,
  );
  if (infoError || !info) {
    return { ok: false, code: storageProblem(infoError) };
  }

  const { data: signedData, error: signedError } =
    await bucketApi.createSignedUrl(
      params.storagePath,
      params.expiresInSeconds,
      {
        download:
          params.disposition === "attachment"
            ? sanitizeContentDispositionFilename(params.originalName)
            : false,
      },
    );
  if (signedError || !signedData?.signedUrl) {
    return { ok: false, code: storageProblem(signedError) };
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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const OLE_MIME_FAMILY = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const TEXT_MIME_FAMILY = new Set(["text/plain", "text/csv"]);

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
      valid: claimed === "image/jpeg",
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
      detectedMime: ZIP_MIME_FAMILY.has(claimed)
        ? claimed
        : "application/octet-stream",
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

export type VerifiedObjectProblem =
  | "INVALID_INPUT"
  | "STORAGE_MISSING"
  | "STORAGE_UNAVAILABLE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE";

/** The object's first 4 KiB; null when the read fails, which proves nothing about the object. */
async function readHeaderBytes(signedUrl: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(signedUrl, { headers: { Range: "bytes=0-4095" } });
    if (!res.ok) return null;
    return new Uint8Array((await res.arrayBuffer()).slice(0, 4096));
  } catch {
    return null;
  }
}

/**
 * Verifies a direct-uploaded object by metadata and a 4 KB magic-byte read,
 * without buffering it; deletes the object on any violation.
 */
export async function verifyDirectUploadedObject(params: {
  bucket: string;
  storagePath: string;
  requiredPrefix: string;
  claimedMimeType: string;
}): Promise<
  | { ok: true; fileName: string; fileSize: number; mimeType: string }
  | { ok: false; code: VerifiedObjectProblem }
> {
  if (!supabaseAdmin) return { ok: false, code: "STORAGE_UNAVAILABLE" };
  if (
    !params.storagePath.startsWith(params.requiredPrefix) ||
    params.storagePath.includes("..")
  ) {
    return { ok: false, code: "INVALID_INPUT" };
  }

  const bucketApi = supabaseAdmin.storage.from(params.bucket);
  const purge = async () => {
    await bucketApi.remove([params.storagePath]).catch(() => undefined);
  };

  const { data: info, error: infoError } = await bucketApi.info(
    params.storagePath,
  );
  if (infoError || !info) {
    return { ok: false, code: storageProblem(infoError) };
  }
  const size = Number(info.size ?? info.metadata?.size ?? 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
    await purge();
    return { ok: false, code: "FILE_TOO_LARGE" };
  }

  const { data: signedData, error: signErr } = await bucketApi.createSignedUrl(
    params.storagePath,
    60,
  );
  if (signErr || !signedData?.signedUrl) {
    return { ok: false, code: storageProblem(signErr) };
  }
  const headerBytes = await readHeaderBytes(signedData.signedUrl);
  if (!headerBytes) return { ok: false, code: "STORAGE_UNAVAILABLE" };

  const check = detectMagicMimeType(headerBytes, params.claimedMimeType);
  if (!check.valid) {
    await purge();
    return { ok: false, code: "UNSUPPORTED_FILE_TYPE" };
  }

  return {
    ok: true,
    fileName: params.storagePath.split("/").at(-1) ?? params.storagePath,
    fileSize: size,
    mimeType: check.detectedMime,
  };
}
