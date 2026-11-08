/**
 * Stateless unsubscribe links for lifecycle email.
 *
 * The token is an HMAC over the user id under the shared link key
 * (`lib/auth/link-signing.ts`), bound to its own purpose so a newsletter
 * token cannot be replayed against an account and vice versa.
 * Timeless on purpose: a footer link in a year-old email must still work, and
 * RFC 8058 one-click depends on it.
 */

import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { canSignLinks, safeEquals, signToken } from "@/lib/auth/link-signing";
import { buildUnsubscribeUrl } from "@/lib/newsletter/tokens";

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

// The token is a hex HMAC-SHA256 digest; anything else fails before the signature check.
const SignedLinkSchema = z.object({
  u: z.string().min(1),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The user a signed `?u=&t=` link names, or null unless its token verifies. */
export function signedLinkUser(params: URLSearchParams): string | null {
  const parsed = SignedLinkSchema.safeParse({
    u: params.get("u") ?? "",
    t: params.get("t") ?? "",
  });
  if (!parsed.success) return null;
  const { u: userId, t: token } = parsed.data;
  return verifyEmailUnsubscribeToken(userId, token) ? userId : null;
}

/**
 * Writes `emailEnabled` for a signed link's user; false only on a database
 * failure. An unknown user (P2003) answers like a real one, so the link is no oracle.
 */
export async function setEmailEnabled(
  userId: string,
  emailEnabled: boolean,
): Promise<boolean> {
  try {
    await prisma.notificationPreference.upsert({
      where: { userId },
      update: { emailEnabled },
      create: { userId, emailEnabled },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return true;
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("[notifications/unsubscribe]", error);
    return false;
  }
}

/** The confirmation page, carrying `query` (e.g. `done=1&u=…&t=…`). */
export function unsubscribePageUrl(query: string): string {
  return `${getAppUrl()}/email/unsubscribe?${query}`;
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
    src.includes("/api/newsletter/unsubscribe") ||
    row.htmlBody.includes("/api/newsletter/unsubscribe")
  ) {
    return listUnsubscribeHeaders(buildUnsubscribeUrl(row.recipient));
  }
  return undefined;
}
