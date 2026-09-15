/**
 * #1653 — stateless unsubscribe links for lifecycle email.
 *
 * The token is an HMAC over the user id under the same secret the newsletter
 * links use (`lib/waitlist/tokens.ts`), bound to its own purpose so a
 * newsletter token cannot be replayed against an account and vice versa.
 * Timeless on purpose: a footer link in a year-old email must still work, and
 * RFC 8058 one-click depends on it.
 */

import { getAppUrl } from "@/lib/url";
import { safeEquals, signToken } from "@/lib/waitlist/tokens";

const PURPOSE = "email-unsubscribe";

export function generateEmailUnsubscribeToken(userId: string): string {
  return signToken(PURPOSE, userId, 0);
}

export function verifyEmailUnsubscribeToken(
  userId: string,
  token: string,
): boolean {
  return safeEquals(token, () => generateEmailUnsubscribeToken(userId));
}

/** The one URL both the footer link (GET) and the one-click POST hit. */
export function buildEmailUnsubscribeUrl(userId: string): string {
  const token = generateEmailUnsubscribeToken(userId);
  return `${getAppUrl()}/api/notifications/unsubscribe?u=${encodeURIComponent(
    userId,
  )}&t=${token}`;
}

/**
 * RFC 8058 headers, the same shape the newsletter broadcast sends: Gmail and
 * Yahoo render their own unsubscribe button and POST to the URL without a
 * click-through.
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
