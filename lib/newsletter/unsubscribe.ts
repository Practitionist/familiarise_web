/**
 * Newsletter Unsubscribe Utilities
 *
 * HMAC-signed token generation and URL building for newsletter unsubscribe links.
 * Used by the unsubscribe route and the admin newsletter send route.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getAppUrl } from "@/lib/url";

function getHmacSecret(): string {
  const secret =
    process.env.NEWSLETTER_HMAC_SECRET ?? process.env.RESEND_API_KEY ?? "";
  if (!secret) {
    throw new Error(
      "Newsletter HMAC secret not configured. Set NEWSLETTER_HMAC_SECRET or RESEND_API_KEY.",
    );
  }
  return secret;
}

/**
 * Generate an HMAC token for the given email.
 * Throws if no HMAC secret is configured.
 */
export function generateUnsubscribeToken(email: string): string {
  return createHmac("sha256", getHmacSecret()).update(email).digest("hex");
}

/**
 * Verify an unsubscribe token using constant-time comparison.
 * Returns false if token is invalid or secret is not configured.
 */
export function verifyUnsubscribeToken(
  email: string,
  token: string,
): boolean {
  try {
    const expected = generateUnsubscribeToken(email);
    if (token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Build a full unsubscribe URL for inclusion in email footers.
 */
export function buildUnsubscribeUrl(email: string): string {
  const baseUrl = getAppUrl();
  const token = generateUnsubscribeToken(email);
  return `${baseUrl}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}
