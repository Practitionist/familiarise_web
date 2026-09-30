import { gunzip as gunzipCb } from "node:zlib";

/**
 * #1829 — the ceiling on an INFLATED webhook payload, mirroring Stream's own
 * `MAX_DECOMPRESSED_BYTES`. Separate from `MAX_WEBHOOK_BODY_BYTES`, which caps
 * the COMPRESSED request: DEFLATE's worst case is 1032:1, so a request inside
 * that cap can still inflate to hundreds of megabytes. Measured on this
 * machine: 254 MiB of zeroes gzips to 252.8 KiB and fits under the 256 KiB cap
 * with room to spare.
 *
 * Lives here rather than in the route because the App Router forbids any export
 * from a `route.ts` beyond the HTTP verbs and route config.
 */
export const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

/**
 * Thrown when a gzipped payload would exceed {@link MAX_DECOMPRESSED_BYTES}.
 * A distinct type rather than a message check, so the route can answer 413 and
 * nothing else has to parse prose to tell "too big" from "corrupt".
 */
export class WebhookPayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(
      `Gzipped Stream webhook payload exceeds ${limitBytes} bytes inflated`,
    );
    this.name = "WebhookPayloadTooLargeError";
  }
}

/**
 * Inflate with a hard ceiling on the OUTPUT.
 *
 * `maxOutputLength` is enforced by zlib as it inflates, so the buffer never
 * reaches the ceiling — this is a bound, not a check performed after the
 * allocation that was the problem. `promisify(gunzip)` cannot express it,
 * because the option is not passed through the promisified single-value
 * signature, so the callback form is used directly.
 */
export async function gunzipWithin(
  raw: Uint8Array,
  limit: number,
): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      gunzipCb(raw, { maxOutputLength: limit }, (err, buf) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new WebhookPayloadTooLargeError(limit);
    }
    throw err;
  }
}
