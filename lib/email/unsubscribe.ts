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
import {
  buildUnsubscribeUrl,
  canSignLinks,
  safeEquals,
  signToken,
} from "@/lib/waitlist/tokens";

const PURPOSE = "email-unsubscribe";
const NOTIFICATION_UNSUBSCRIBE_RE =
  /(https?:\/\/[^\s"'<>]*\/api\/notifications\/unsubscribe\?u=([^&"'\s<>]+)&t=([^&"'\s<>]+))/;

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

/**
 * Reconstructs RFC 8058 one-click headers from a persisted `FailedEmail` row's
 * body links when HMAC signing is available; returns `undefined` for mandatory
 * notices (`category === null`) that carry no unsubscribe link.
 */
export function reconstructUnsubscribeHeaders(row: {
  htmlBody: string;
  textBody: string | null;
  recipient: string;
}): Record<string, string> | undefined {
  if (!canSignLinks()) return undefined;
  const src = row.textBody ?? row.htmlBody;
  const notifMatch =
    NOTIFICATION_UNSUBSCRIBE_RE.exec(src) ??
    NOTIFICATION_UNSUBSCRIBE_RE.exec(row.htmlBody);
  if (notifMatch?.[1] && notifMatch[2] && notifMatch[3]) {
    try {
      const userId = decodeURIComponent(notifMatch[2]);
      const token = decodeURIComponent(notifMatch[3]);
      if (verifyEmailUnsubscribeToken(userId, token)) {
        return listUnsubscribeHeaders(notifMatch[1]);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (
    src.includes("/api/waitlist/unsubscribe") ||
    row.htmlBody.includes("/api/waitlist/unsubscribe")
  ) {
    return listUnsubscribeHeaders(buildUnsubscribeUrl(row.recipient));
  }
  return undefined;
}
