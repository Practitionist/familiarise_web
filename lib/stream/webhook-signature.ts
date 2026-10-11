import crypto from "node:crypto";
import { verifySignature } from "stream-chat";
import { streamLogger } from "@/lib/stream-logger";

export const MAX_WEBHOOK_COMPRESSED_BYTES = 512 * 1024;
export const MAX_WEBHOOK_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

const HEX_SHA256_SIGNATURE_RE = /^[0-9a-f]{64}$/i;

export function isValidStreamSignatureFormat(
  signature: string | null | undefined,
): signature is string {
  return (
    typeof signature === "string" && HEX_SHA256_SIGNATURE_RE.test(signature)
  );
}

/**
 * Verifies the `x-api-key` header in constant time whenever
 * `NEXT_PUBLIC_STREAM_API_KEY` (or `expectedApiKey`) is configured.
 */
export function verifyStreamApiKeyHeader(
  apiKeyHeader: string | null | undefined,
  expectedApiKey: string | undefined = process.env.NEXT_PUBLIC_STREAM_API_KEY,
): boolean {
  const expected = expectedApiKey?.trim();
  if (!expected) return true;
  const provided = apiKeyHeader?.trim();
  if (!provided) return false;
  const actualBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return (
    actualBuf.byteLength === expectedBuf.byteLength &&
    crypto.timingSafeEqual(actualBuf, expectedBuf)
  );
}

/**
 * Returns the primary Stream webhook signing secret (STREAM_WEBHOOK_SECRET,
 * falling back to STREAM_API_SECRET).
 */
export function getWebhookSecret(): string | undefined {
  return process.env.STREAM_WEBHOOK_SECRET || process.env.STREAM_API_SECRET;
}

/**
 * Returns the ordered list of active Stream webhook signing secrets:
 * primary secret first, followed by STREAM_WEBHOOK_SECRET_PREVIOUS during
 * zero-downtime secret rotation.
 */
export function getWebhookSecrets(): string[] {
  const primary = getWebhookSecret();
  const previous = process.env.STREAM_WEBHOOK_SECRET_PREVIOUS?.trim();
  const secrets: string[] = [];
  if (primary) secrets.push(primary);
  if (previous && previous !== primary) secrets.push(previous);
  return secrets;
}

/**
 * Verifies a Stream webhook `x-signature` header against the primary secret
 * and, if configured, falls back to `STREAM_WEBHOOK_SECRET_PREVIOUS`.
 */
export function verifyStreamWebhookSignature(
  body: string,
  signature: string | null | undefined,
  primarySecret?: string,
  previousSecret: string | undefined = process.env
    .STREAM_WEBHOOK_SECRET_PREVIOUS,
): boolean {
  if (!isValidStreamSignatureFormat(signature)) {
    streamLogger.warn(
      "Missing or malformed x-signature header in Stream webhook request",
    );
    return false;
  }

  const candidateSecrets: string[] = [];
  const primary = primarySecret ?? getWebhookSecret();
  if (primary) candidateSecrets.push(primary);
  const previous = previousSecret?.trim();
  if (previous && previous !== primary) candidateSecrets.push(previous);

  for (const secret of candidateSecrets) {
    try {
      if (verifySignature(body, signature, secret)) {
        return true;
      }
    } catch (error) {
      streamLogger.error("Error verifying Stream webhook signature", error);
    }
  }

  return false;
}
