import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { VIA_TOKEN_PATTERN } from "./attribution-token-shape";

const secretSchema = z.string().min(16);

function viaSecret(): string {
  return secretSchema.parse(process.env.BETTER_AUTH_SECRET);
}

function mac(consultantProfileId: string): string {
  return createHmac("sha256", viaSecret())
    .update(`expert-via:${consultantProfileId}`)
    .digest("base64url");
}

export function signExpertVia(consultantProfileId: string): string {
  return `${consultantProfileId}.${mac(consultantProfileId)}`;
}

/** The consultant profile the token was minted for, or null when it is malformed or forged. */
export function verifyExpertVia(
  token: string | null | undefined,
): string | null {
  if (!token || !VIA_TOKEN_PATTERN.test(token)) return null;
  const dot = token.indexOf(".");
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(id));
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? id : null;
}

export function expertShareHref(consultantProfileId: string): string {
  return `/explore/experts/${encodeURIComponent(consultantProfileId)}?via=${encodeURIComponent(signExpertVia(consultantProfileId))}`;
}
