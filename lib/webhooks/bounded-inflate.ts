import { createGunzip } from "node:zlib";

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
 * #1829 — the bound is enforced by COUNTING here, not by zlib's
 * `maxOutputLength`, and that is not a stylistic choice. The first version of
 * this function passed `maxOutputLength` to `gunzip` and passed both its unit
 * test and a local build, because the local Node honours the option. Probing the
 * Netlify deploy preview then showed it does not: a 20 KiB gzip of a 20 MiB
 * payload returned `401 Invalid signature` — meaning the body was fully inflated
 * and the signature check ran against it — at every size from 14 MiB upward,
 * while the uncompressed 400 KiB request correctly returned 413 from the
 * compressed-body cap.
 *
 * So the deployment, which is the only environment that matters for an
 * unauthenticated memory-exhaustion vector, was doing exactly the unbounded
 * allocation the fix was written to remove. A test that runs on the developer's
 * machine cannot see this; only the deployed surface can. The bound now lives in
 * code we own: the stream is destroyed the moment the running total passes the
 * limit, so the buffer never exceeds the ceiling by more than one chunk, on
 * every Node version and every bundler.
 *
 * `gunzip.destroy()` matters as much as the throw. Aborting mid-stream releases
 * the inflater instead of letting it finish into a buffer nobody will read.
 */
export async function gunzipWithin(
  raw: Uint8Array,
  limit: number,
): Promise<Buffer> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      reject(err);
    };

    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        fail(new WebhookPayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    gunzip.on("error", (err: Error) => fail(err));

    gunzip.end(Buffer.from(raw));
  });
}
