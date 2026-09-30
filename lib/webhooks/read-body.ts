/**
 * #1459 — a webhook payload is a few kilobytes; the largest we have seen is
 * well under a hundredth of this. Anything bigger is not a delivery we have to
 * serve, and reading it into a buffer to verify it is work an unauthenticated
 * caller gets to make us do. Shared by every signed receiver (#1647).
 */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * Read the delivery body as BYTES, bounded.
 *
 * #1829 added the bytes primitive and rebuilt the text reader on top of it,
 * because a receiver that must inspect the raw octets BEFORE it can decode them
 * cannot use a helper that has already run a lossy `TextDecoder` over the
 * payload. Stream is exactly that receiver: it sniffs the gzip magic number
 * (`1f 8b`) to decide whether the delivery is compressed, and decoding binary
 * through UTF-8 replaces every byte above 0x7F with U+FFFD. The magic prefix
 * would survive only by accident and the compressed stream would be
 * unrecoverable by the time the caller saw it — which is why the Stream route
 * used to bypass this cap entirely with an unbounded `arrayBuffer()`.
 *
 * #1459 — Content-Length is optional and set by the caller, so a header check
 * alone is a cap only a well-behaved sender honours: omit it, or send chunked,
 * and `req.arrayBuffer()` would buffer whatever arrives. Counting the bytes as
 * they stream in and abandoning the read the moment the cap is passed is what
 * makes the limit hold against the caller it was written for.
 *
 * @returns The raw bytes, or `null` when the request exceeded the cap.
 */
export async function readBodyBytesWithinCap(
  req: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<Uint8Array | null> {
  const stream = req.body;
  // No stream means there is nothing to bound. `arrayBuffer()` on a body-less
  // request returns an empty buffer, and an empty buffer is what the caller's
  // signature check needs in order to reject it. Note this branch is not a
  // bypass: a Request that has already had its body consumed cannot be
  // re-streamed, so the byte count it yields is necessarily zero or a body the
  // runtime is holding in full — and the only way to reach this line with a
  // large payload is to have constructed the Request yourself.
  if (!stream) {
    const empty = Buffer.from(await req.arrayBuffer());
    return empty.byteLength > maxBytes ? null : empty;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * The text twin, for the receivers whose payload is JSON and needs nothing from
 * the octets. Same cap, same streaming abort, same `null` sentinel.
 *
 * @returns The raw body, or `null` when the request exceeded the cap.
 */
export async function readBodyWithinCap(req: Request): Promise<string | null> {
  const bytes = await readBodyBytesWithinCap(req);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
