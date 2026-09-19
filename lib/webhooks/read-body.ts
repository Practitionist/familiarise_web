/**
 * #1459 — a webhook payload is a few kilobytes; the largest we have seen is
 * well under a hundredth of this. Anything bigger is not a delivery we have to
 * serve, and reading it into a buffer to verify it is work an unauthenticated
 * caller gets to make us do. Shared by every signed receiver (#1647).
 */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * #1459 — Content-Length is optional and set by the caller, so the header check
 * alone is a cap only a well-behaved sender honours: omit it, or send chunked,
 * and `req.text()` would buffer whatever arrives. Counting the bytes as they
 * stream in and abandoning the read the moment the cap is passed is what makes
 * the limit hold against the caller it was written for. The whole body is
 * decoded in one pass at the end, because a multi-byte character split across
 * two chunks must not be decoded twice — the signature covers these exact bytes.
 *
 * @returns The raw body, or `null` when the request exceeded the cap.
 */
export async function readBodyWithinCap(req: Request): Promise<string | null> {
  const stream = req.body;
  // No stream means there is no body to bound; `text()` yields "" and the
  // caller's signature check rejects it.
  if (!stream) return req.text();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
