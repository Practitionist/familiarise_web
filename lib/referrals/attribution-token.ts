import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  ATTRIBUTION_COOKIE_MAX_AGE_S,
  parseViaToken,
} from "./attribution-token-shape";

/** Clock skew tolerated on a token's issued-at. */
const MAX_FUTURE_SKEW_S = 5 * 60;

const secretSchema = z.string().min(16);

/** A key bound to this purpose, derived from the auth secret; null when the secret is unusable. */
function viaKey(): Buffer | null {
  const secret = secretSchema.safeParse(process.env.BETTER_AUTH_SECRET);
  if (!secret.success) return null;
  return createHmac("sha256", secret.data)
    .update("familiarise/expert-via-key/v1")
    .digest();
}

function mac(key: Buffer, consultantProfileId: string, iat: string): string {
  return createHmac("sha256", key)
    .update(`${consultantProfileId}.${iat}`)
    .digest("base64url");
}

/**
 * The consultant profile the token was minted for, or null when it is malformed, forged,
 * older than the attribution window, or the secret is unusable. Never throws.
 */
export function verifyExpertVia(
  token: unknown,
  now: Date = new Date(),
): string | null {
  const valid = parseViaToken(token);
  const key = valid ? viaKey() : null;
  if (!valid || !key) return null;
  const [id, iat, given] = valid.split(".");
  const ageS = now.getTime() / 1000 - Number(iat);
  if (ageS < -MAX_FUTURE_SKEW_S || ageS > ATTRIBUTION_COOKIE_MAX_AGE_S) {
    return null;
  }
  const expected = Buffer.from(mac(key, id, iat));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length) return null;
  return timingSafeEqual(actual, expected) ? id : null;
}

/** The expert's public page with a freshly signed own-link token. */
export function expertShareHref(
  consultantProfileId: string,
  now: Date = new Date(),
): string {
  const key = viaKey();
  if (!key) throw new Error("BETTER_AUTH_SECRET is not set");
  const iat = String(Math.floor(now.getTime() / 1000));
  const token = `${consultantProfileId}.${iat}.${mac(key, consultantProfileId, iat)}`;
  return `/explore/experts/${encodeURIComponent(consultantProfileId)}?via=${encodeURIComponent(token)}`;
}
