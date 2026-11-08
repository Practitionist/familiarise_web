/**
 * The HMAC every unauthenticated link on the platform is signed with: newsletter
 * confirm and unsubscribe, account email unsubscribe, calendar and support links.
 *
 * The key is derived from `BETTER_AUTH_SECRET` under a fixed label, so rotating the
 * auth secret voids every link already sent. Each link binds its own purpose, so a
 * token minted for one purpose never verifies for another.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const secretSchema = z.string().min(16);

const LINK_SIGNING_LABEL = "familiarise/link-signing/v1";

/** A key bound to `label`, derived from the auth secret; null when the secret is unusable. */
export function deriveAuthKey(label: string): Buffer | null {
  const secret = secretSchema.safeParse(process.env.BETTER_AUTH_SECRET);
  if (!secret.success) return null;
  return createHmac("sha256", secret.data).update(label).digest();
}

function linkKey(): Buffer {
  const key = deriveAuthKey(LINK_SIGNING_LABEL);
  if (!key) {
    throw new Error("BETTER_AUTH_SECRET is not set; links cannot be signed");
  }
  return key;
}

/** Hex HMAC-SHA256 over `purpose|subject|issuedAt`; throws when links cannot be signed. */
export function signToken(
  purpose: string,
  subject: string,
  issuedAt: number,
): string {
  return createHmac("sha256", linkKey())
    .update(`${purpose}|${subject}|${issuedAt}`)
    .digest("hex");
}

/** Constant-time compare against a lazily computed token; false when signing is unavailable. */
export function safeEquals(token: string, expected: () => string): boolean {
  try {
    const want = expected();
    if (token.length !== want.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(want));
  } catch {
    return false;
  }
}

/**
 * Whether links can be signed at all. Callers check this before any lookup so a
 * signing outage fails the same way for every address and is never a membership oracle.
 */
export function canSignLinks(): boolean {
  return deriveAuthKey(LINK_SIGNING_LABEL) !== null;
}
