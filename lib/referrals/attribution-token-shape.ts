/** Edge- and client-safe attribution constants; the MAC itself lives in attribution-token.ts. */
import { z } from "zod";

/** First-party cookies set by the share links; 30 days, matching the attribution window. */
export const REFERRAL_CODE_COOKIE = "fam_ref";
export const EXPERT_VIA_COOKIE = "fam_via";
export const ATTRIBUTION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** `<consultantProfileId>.<issued-at seconds>.<base64url HMAC>`; the edge checks only this shape. */
export const viaTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/);

/** The token when it has the right shape, else null; never throws. */
export function parseViaToken(raw: unknown): string | null {
  const parsed = viaTokenSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
