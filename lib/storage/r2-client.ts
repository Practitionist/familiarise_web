import { createHash, createHmac } from "node:crypto";

export const DEFAULT_R2_RECORDINGS_BUCKET = "recordings";
export const DEFAULT_R2_PREVIEWS_BUCKET = "recording-previews";
export const R2_MULTIPART_PART_SIZE = 10 * 1024 * 1024; // 10 MB

const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function getR2Credentials(): R2Credentials | null {
  const accountId = (
    process.env.R2_ACCOUNT_ID ??
    process.env.CLOUDFLARE_R2_ACCOUNT_ID ??
    ""
  ).trim();
  const accessKeyId = (
    process.env.R2_ACCESS_KEY_ID ??
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ??
    ""
  ).trim();
  const secretAccessKey = (
    process.env.R2_SECRET_ACCESS_KEY ??
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ??
    ""
  ).trim();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return { accountId, accessKeyId, secretAccessKey };
}

export function isR2Configured(): boolean {
  return getR2Credentials() !== null;
}

export function getR2RecordingsBucket(): string {
  return (
    process.env.R2_RECORDINGS_BUCKET?.trim() || DEFAULT_R2_RECORDINGS_BUCKET
  );
}

export function getR2PreviewsBucket(): string {
  return process.env.R2_PREVIEWS_BUCKET?.trim() || DEFAULT_R2_PREVIEWS_BUCKET;
}

export function getR2PublicBaseUrl(): string | null {
  const raw = process.env.R2_PUBLIC_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function requireR2Credentials(): R2Credentials {
  const creds = getR2Credentials();
  if (!creds) {
    throw new Error(
      "Cloudflare R2 is not configured (missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY)",
    );
  }
  return creds;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectKey(key: string): string {
  return key
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function formatAmzTimestamps(now: Date): {
  amzDate: string;
  dateStamp: string;
} {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region = "auto",
  service = "s3",
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function buildCanonicalQueryString(
  params: Record<string, string | undefined>,
): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v ?? "")] as const)
    .sort(([aKey, aVal], [bKey, bVal]) =>
      aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function signR2Request(opts: {
  method: "GET" | "PUT" | "POST" | "DELETE";
  bucket: string;
  key: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
}): {
  url: string;
  headers: Record<string, string>;
} {
  const creds = requireR2Credentials();
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = formatAmzTimestamps(now);
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeRfc3986(opts.bucket)}/${encodeObjectKey(opts.key)}`;
  const canonicalQuery = buildCanonicalQueryString(opts.query ?? {});
  const payloadHash = opts.payloadHash ?? EMPTY_PAYLOAD_SHA256;

  const rawHeaders: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      rawHeaders[k.toLowerCase()] = v.trim();
    }
  }

  const sortedHeaderKeys = Object.keys(rawHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${rawHeaders[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp);
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders: Record<string, string> = {
    ...rawHeaders,
    authorization,
  };
  delete requestHeaders.host;

  const querySuffix = canonicalQuery ? `?${canonicalQuery}` : "";
  return {
    url: `https://${host}${canonicalUri}${querySuffix}`,
    headers: requestHeaders,
  };
}

/**
 * Generate an S3 Signature V4 presigned GET URL against Cloudflare R2.
 * Supports HTTP Range requests natively because only the `host` header is signed.
 */
export function createR2PresignedGetUrl(opts: {
  bucket?: string;
  key: string;
  expiresInSeconds?: number;
  now?: Date;
}): string {
  const creds = requireR2Credentials();
  const bucket = opts.bucket || getR2RecordingsBucket();
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = formatAmzTimestamps(now);
  const expires = Math.max(
    1,
    Math.min(604800, Math.floor(opts.expiresInSeconds ?? 3600)),
  );
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeRfc3986(bucket)}/${encodeObjectKey(opts.key)}`;
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;

  const canonicalQuery = buildCanonicalQueryString({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${creds.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  });

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp);
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Upload a Buffer or Uint8Array to R2 using a single signed PUT request.
 */
export async function uploadR2Object(opts: {
  bucket?: string;
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
}): Promise<{ etag: string | null; key: string; bucket: string }> {
  const bucket = opts.bucket || getR2RecordingsBucket();
  const bodyBytes =
    typeof opts.body === "string"
      ? Buffer.from(opts.body, "utf8")
      : Buffer.from(
          opts.body.buffer,
          opts.body.byteOffset,
          opts.body.byteLength,
        );
  const payloadHash = sha256Hex(bodyBytes);
  const extraHeaders: Record<string, string> = {};
  if (opts.contentType) {
    extraHeaders["content-type"] = opts.contentType;
  }

  const signed = signR2Request({
    method: "PUT",
    bucket,
    key: opts.key,
    headers: extraHeaders,
    payloadHash,
  });

  const response = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(bodyBytes),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `R2 PUT failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
    );
  }

  return {
    etag: response.headers.get("etag"),
    key: opts.key,
    bucket,
  };
}

async function initiateMultipartUpload(opts: {
  bucket: string;
  key: string;
  contentType?: string;
}): Promise<string> {
  const extraHeaders: Record<string, string> = {};
  if (opts.contentType) {
    extraHeaders["content-type"] = opts.contentType;
  }

  const signed = signR2Request({
    method: "POST",
    bucket: opts.bucket,
    key: opts.key,
    query: { uploads: "" },
    headers: extraHeaders,
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `R2 CreateMultipartUpload failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
    );
  }

  const xml = await response.text();
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match?.[1]) {
    throw new Error("R2 CreateMultipartUpload response missing UploadId");
  }
  return match[1].trim();
}

async function uploadMultipartPart(opts: {
  bucket: string;
  key: string;
  uploadId: string;
  partNumber: number;
  body: Buffer;
}): Promise<string> {
  const payloadHash = sha256Hex(opts.body);
  const signed = signR2Request({
    method: "PUT",
    bucket: opts.bucket,
    key: opts.key,
    query: {
      partNumber: String(opts.partNumber),
      uploadId: opts.uploadId,
    },
    payloadHash,
  });

  const response = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(opts.body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `R2 UploadPart #${opts.partNumber} failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
    );
  }

  const etag = response.headers.get("etag");
  if (!etag) {
    throw new Error(
      `R2 UploadPart #${opts.partNumber} response missing ETag header`,
    );
  }
  return etag;
}

async function completeMultipartUpload(opts: {
  bucket: string;
  key: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const partsXml = opts.parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
    )
    .join("");
  const bodyXml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
  const bodyBuffer = Buffer.from(bodyXml, "utf8");
  const payloadHash = sha256Hex(bodyBuffer);

  const signed = signR2Request({
    method: "POST",
    bucket: opts.bucket,
    key: opts.key,
    query: { uploadId: opts.uploadId },
    headers: { "content-type": "application/xml" },
    payloadHash,
  });

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: new Uint8Array(bodyBuffer),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `R2 CompleteMultipartUpload failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
    );
  }
}

async function abortMultipartUpload(opts: {
  bucket: string;
  key: string;
  uploadId: string;
}): Promise<void> {
  const signed = signR2Request({
    method: "DELETE",
    bucket: opts.bucket,
    key: opts.key,
    query: { uploadId: opts.uploadId },
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });

  await fetch(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  }).catch(() => undefined);
}

/**
 * Stream a ReadableStream<Uint8Array> to R2 in bounded 10 MB parts.
 * Streams <= 10 MB are uploaded in a single PUT; larger streams use S3 Multipart Upload
 * and abort the upload automatically on any mid-stream failure.
 */
export async function streamMultipartToR2(opts: {
  bucket?: string;
  key: string;
  stream: ReadableStream<Uint8Array>;
  contentType?: string;
  maxBytes?: number;
  partSize?: number;
}): Promise<{ key: string; bucket: string; size: number; parts: number }> {
  const bucket = opts.bucket || getR2RecordingsBucket();
  const partSize = opts.partSize ?? R2_MULTIPART_PART_SIZE;
  const reader = opts.stream.getReader();

  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let uploadId: string | null = null;
  let partNumber = 1;
  const completedParts: Array<{ partNumber: number; etag: string }> = [];

  const takeBytes = (count: number): Buffer => {
    const combined = Buffer.concat(chunks, bufferedBytes);
    const slice = combined.subarray(0, count);
    const remainder = combined.subarray(count);
    chunks = remainder.byteLength > 0 ? [remainder] : [];
    bufferedBytes = remainder.byteLength;
    return slice;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (opts.maxBytes !== undefined && totalBytes > opts.maxBytes) {
        throw new Error(
          `RECORDING_OBJECT_CEILING: Recording stream exceeded maximum size (${Math.round(opts.maxBytes / 1024 / 1024)}MB)`,
        );
      }

      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
      bufferedBytes += value.byteLength;

      while (bufferedBytes > partSize) {
        if (!uploadId) {
          uploadId = await initiateMultipartUpload({
            bucket,
            key: opts.key,
            contentType: opts.contentType,
          });
        }
        const partBuffer = takeBytes(partSize);
        const etag = await uploadMultipartPart({
          bucket,
          key: opts.key,
          uploadId,
          partNumber,
          body: partBuffer,
        });
        completedParts.push({ partNumber, etag });
        partNumber += 1;
      }
    }

    if (!uploadId) {
      const singleBody =
        bufferedBytes > 0
          ? Buffer.concat(chunks, bufferedBytes)
          : Buffer.alloc(0);
      await uploadR2Object({
        bucket,
        key: opts.key,
        body: singleBody,
        contentType: opts.contentType,
      });
      return { key: opts.key, bucket, size: totalBytes, parts: 1 };
    }

    if (bufferedBytes > 0) {
      const finalPart = Buffer.concat(chunks, bufferedBytes);
      chunks = [];
      bufferedBytes = 0;
      const etag = await uploadMultipartPart({
        bucket,
        key: opts.key,
        uploadId,
        partNumber,
        body: finalPart,
      });
      completedParts.push({ partNumber, etag });
    }

    await completeMultipartUpload({
      bucket,
      key: opts.key,
      uploadId,
      parts: completedParts,
    });

    return {
      key: opts.key,
      bucket,
      size: totalBytes,
      parts: completedParts.length,
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (uploadId) {
      await abortMultipartUpload({
        bucket,
        key: opts.key,
        uploadId,
      });
    }
    throw error;
  }
}

/**
 * Delete an object from R2, treating 404 Not Found as success.
 */
export async function deleteR2Object(opts: {
  bucket?: string;
  key: string;
}): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
  const bucket = opts.bucket || getR2RecordingsBucket();
  const signed = signR2Request({
    method: "DELETE",
    bucket,
    key: opts.key,
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });

  const response = await fetch(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  });

  if (response.status === 404) {
    return { success: true, notFound: true };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return {
      success: false,
      error: `R2 DELETE failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
    };
  }

  return { success: true };
}
