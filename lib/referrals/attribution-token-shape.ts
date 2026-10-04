/** Edge- and client-safe attribution constants; the MAC itself lives in attribution-token.ts. */

/** First-party cookies set by the share links; 30 days, matching the attribution window. */
export const REFERRAL_CODE_COOKIE = "fam_ref";
export const EXPERT_VIA_COOKIE = "fam_via";
export const ATTRIBUTION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** `<consultantProfileId>.<base64url HMAC>`; the edge only checks this shape, Node verifies the MAC. */
export const VIA_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{43}$/;
