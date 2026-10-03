import { verifySignature } from "stream-chat";
import { streamLogger } from "@/lib/stream-logger";

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
  if (!signature) {
    streamLogger.warn("No x-signature header found in Stream webhook request");
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
