/**
 * Newsletter Unsubscribe Utilities
 *
 * HMAC-signed token generation and URL building for newsletter unsubscribe links.
 * Used by the unsubscribe route and the admin newsletter send route.
 */

import { createHmac } from "crypto";
import { getAppUrl } from "@/lib/url";

const HMAC_SECRET =
  process.env.NEWSLETTER_HMAC_SECRET ?? process.env.RESEND_API_KEY ?? "";

/**
 * Generate an HMAC token for the given email.
 * Used to create signed unsubscribe links.
 */
export function generateUnsubscribeToken(email: string): string {
  return createHmac("sha256", HMAC_SECRET).update(email).digest("hex");
}

/**
 * Build a full unsubscribe URL for inclusion in email footers.
 */
export function buildUnsubscribeUrl(email: string): string {
  const baseUrl = getAppUrl();
  const token = generateUnsubscribeToken(email);
  return `${baseUrl}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}
