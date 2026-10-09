import { createHash, createHmac } from "node:crypto";

export const R2_MULTIPART_PART_SIZE = 10 * 1024 * 1024; // 10 MB

const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface R2Config {
  endpoint: URL;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function getR2Config(): R2Config | null {
  const endpoint = process.env.R2_S3_ENDPOINT?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  try {
    return {
      endpoint: new URL(endpoint),
      bucket,
      accessKeyId,
      secretAccessKey,
    };
  } catch {
    return null;
  }
}

export function isR2Configured(): boolean {
  return getR2Config() !== null;
}

function requireR2Config(): R2Config {
  const config = getR2Config();
  if (!config) {
    throw new Error(
      "Cloudflare R2 is not configured (R2_S3_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)",
    );
  }
  return config;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectKey(key: string): string {
  return key
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

/** Path-style object URI under the endpoint's own path prefix, if any. */
function objectUri(config: R2Config, key: string): string {
  const prefix = config.endpoint.pathname.replace(/\/+$/, "");
  return `${prefix}/${encodeRfc3986(config.bucket)}/${encodeObjectKey(key)}`;
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

function deriveSigningKey(secretAccessKey: string, dateStamp: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, "auto");
  const kService = hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function formatR2ErrorDetail(errorText: string): string {
  return errorText ? `: ${errorText.slice(0, 300)}` : "";
}

function buildCanonicalQueryString(
  params: Record<string, string | undefined>,
): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v ?? "")] as const)
    .sort(
      ([aKey, aVal], [bKey, bVal]) =>
        compareCodeUnits(aKey, bKey) || compareCodeUnits(aVal, bVal),
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function signR2Request(opts: {
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  key: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  payloadHash?: string;
}): {
  url: string;
  headers: Record<string, string>;
} {
  const config = requireR2Config();
  const { amzDate, dateStamp } = formatAmzTimestamps(new Date());
  const host = config.endpoint.host;
  const canonicalUri = objectUri(config, opts.key);
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

  const sortedHeaderKeys = Object.keys(rawHeaders).sort(compareCodeUnits);
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

  const signature = createHmac(
    "sha256",
    deriveSigningKey(config.secretAccessKey, dateStamp),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders: Record<string, string> = {
    ...rawHeaders,
    authorization,
  };
  delete requestHeaders.host;

  const querySuffix = canonicalQuery ? `?${canonicalQuery}` : "";
  return {
    url: `${config.endpoint.origin}${canonicalUri}${querySuffix}`,
    headers: requestHeaders,
  };
}

/**
 * SigV4 presigned GET URL. Only `host` is signed, so HTTP Range requests work.
 */
export function createR2PresignedGetUrl(opts: {
  key: string;
  expiresInSeconds?: number;
  now?: Date;
}): string {
  const config = requireR2Config();
  const { amzDate, dateStamp } = formatAmzTimestamps(opts.now ?? new Date());
  const expires = Math.max(
    1,
    Math.min(604800, Math.floor(opts.expiresInSeconds ?? 3600)),
  );
  const host = config.endpoint.host;
  const canonicalUri = objectUri(config, opts.key);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;

  const canonicalQuery = buildCanonicalQueryString({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
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

  const signature = createHmac(
    "sha256",
    deriveSigningKey(config.secretAccessKey, dateStamp),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  return `${config.endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function putR2Object(opts: {
  key: string;
  body: Buffer;
  contentType?: string;
}): Promise<void> {
  const signed = signR2Request({
    method: "PUT",
    key: opts.key,
    headers: opts.contentType ? { "content-type": opts.contentType } : {},
    payloadHash: sha256Hex(opts.body),
  });

  const response = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(opts.body),
  });

  if (!response.ok) {
    const detail = formatR2ErrorDetail(await response.text().catch(() => ""));
    throw new Error(
      `R2 PUT failed (${response.status} ${response.statusText})${detail}`,
    );
  }
}

async function initiateMultipartUpload(opts: {
  key: string;
  contentType?: string;
}): Promise<string> {
  const signed = signR2Request({
    method: "POST",
    key: opts.key,
    query: { uploads: "" },
    headers: opts.contentType ? { "content-type": opts.contentType } : {},
  });

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
  });

  if (!response.ok) {
    const detail = formatR2ErrorDetail(await response.text().catch(() => ""));
    throw new Error(
      `R2 CreateMultipartUpload failed (${response.status} ${response.statusText})${detail}`,
    );
  }

  const match = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text());
  if (!match?.[1]) {
    throw new Error("R2 CreateMultipartUpload response missing UploadId");
  }
  return match[1].trim();
}

async function uploadMultipartPart(opts: {
  key: string;
  uploadId: string;
  partNumber: number;
  body: Buffer;
}): Promise<string> {
  const signed = signR2Request({
    method: "PUT",
    key: opts.key,
    query: {
      partNumber: String(opts.partNumber),
      uploadId: opts.uploadId,
    },
    payloadHash: sha256Hex(opts.body),
  });

  const response = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(opts.body),
  });

  if (!response.ok) {
    const detail = formatR2ErrorDetail(await response.text().catch(() => ""));
    throw new Error(
      `R2 UploadPart #${opts.partNumber} failed (${response.status} ${response.statusText})${detail}`,
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

/** S3 may answer CompleteMultipartUpload with 200 and an `<Error>` body. */
export function parseCompleteMultipartUploadResponse(xml: string): void {
  if (/<Error>/.test(xml)) {
    const code = /<Code>([^<]*)<\/Code>/.exec(xml)?.[1] ?? "Unknown";
    const message = /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? "";
    throw new Error(`R2 CompleteMultipartUpload error ${code}: ${message}`);
  }
  if (!/<CompleteMultipartUploadResult[\s>/]/.test(xml)) {
    throw new Error(
      `R2 CompleteMultipartUpload returned an unexpected body${formatR2ErrorDetail(xml)}`,
    );
  }
}

async function completeMultipartUpload(opts: {
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
  const bodyBuffer = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`,
    "utf8",
  );

  const signed = signR2Request({
    method: "POST",
    key: opts.key,
    query: { uploadId: opts.uploadId },
    headers: { "content-type": "application/xml" },
    payloadHash: sha256Hex(bodyBuffer),
  });

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: new Uint8Array(bodyBuffer),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `R2 CompleteMultipartUpload failed (${response.status} ${response.statusText})${formatR2ErrorDetail(text)}`,
    );
  }
  parseCompleteMultipartUploadResponse(text);
}

async function abortMultipartUpload(opts: {
  key: string;
  uploadId: string;
}): Promise<void> {
  const signed = signR2Request({
    method: "DELETE",
    key: opts.key,
    query: { uploadId: opts.uploadId },
  });

  await fetch(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  }).catch(() => undefined);
}

/**
 * Stream to R2 in bounded parts: a single PUT up to one part, multipart above
 * it. Any failure aborts the multipart upload. `size` is the bytes streamed.
 */
export async function streamMultipartToR2(opts: {
  key: string;
  stream: ReadableStream<Uint8Array>;
  contentType?: string;
  maxBytes?: number;
  partSize?: number;
}): Promise<{ key: string; size: number; parts: number }> {
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

  const flushFullParts = async () => {
    while (bufferedBytes > partSize) {
      uploadId ??= await initiateMultipartUpload({
        key: opts.key,
        contentType: opts.contentType,
      });
      const etag = await uploadMultipartPart({
        key: opts.key,
        uploadId,
        partNumber,
        body: takeBytes(partSize),
      });
      completedParts.push({ partNumber, etag });
      partNumber += 1;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (opts.maxBytes !== undefined && totalBytes > opts.maxBytes) {
        throw new Error(
          `Recording stream exceeded the ${Math.round(opts.maxBytes / 1024 / 1024)}MB ceiling`,
        );
      }

      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
      bufferedBytes += value.byteLength;
      await flushFullParts();
    }

    if (!uploadId) {
      await putR2Object({
        key: opts.key,
        body: Buffer.concat(chunks, bufferedBytes),
        contentType: opts.contentType,
      });
      return { key: opts.key, size: totalBytes, parts: 1 };
    }

    if (bufferedBytes > 0) {
      const finalPart = Buffer.concat(chunks, bufferedBytes);
      chunks = [];
      bufferedBytes = 0;
      const etag = await uploadMultipartPart({
        key: opts.key,
        uploadId,
        partNumber,
        body: finalPart,
      });
      completedParts.push({ partNumber, etag });
    }

    await completeMultipartUpload({
      key: opts.key,
      uploadId,
      parts: completedParts,
    });

    return { key: opts.key, size: totalBytes, parts: completedParts.length };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (uploadId) {
      await abortMultipartUpload({ key: opts.key, uploadId });
    }
    throw error;
  }
}

/** Stored object size from HeadObject, or null when the key does not exist. */
export async function headR2Object(opts: {
  key: string;
}): Promise<{ contentLength: number } | null> {
  const signed = signR2Request({ method: "HEAD", key: opts.key });
  const response = await fetch(signed.url, {
    method: "HEAD",
    headers: signed.headers,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `R2 HEAD failed (${response.status} ${response.statusText})`,
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error("R2 HEAD response missing a valid Content-Length");
  }
  return { contentLength };
}

/** Delete an object, treating 404 Not Found as success. */
export async function deleteR2Object(opts: {
  key: string;
}): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
  const signed = signR2Request({ method: "DELETE", key: opts.key });

  const response = await fetch(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  });

  if (response.status === 404) {
    return { success: true, notFound: true };
  }

  if (!response.ok) {
    const detail = formatR2ErrorDetail(await response.text().catch(() => ""));
    return {
      success: false,
      error: `R2 DELETE failed (${response.status} ${response.statusText})${detail}`,
    };
  }

  return { success: true };
}
