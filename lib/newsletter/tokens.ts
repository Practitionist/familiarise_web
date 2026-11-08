/**
 * Stateless links for the newsletter: confirm and unsubscribe.
 *
 * Both are HMACs over the subscriber's email rather than random tokens in a
 * column, so a link survives a reseed and nothing has to be cleaned up when it
 * goes unused. The purpose is bound into the signature, which is what stops a
 * confirm link from doubling as an unsubscribe link.
 *
 * Confirm links carry their issue time in the URL and expire; unsubscribe
 * links never do — an unsubscribe link in a two-year-old email must still
 * work, and RFC 8058 one-click depends on it.
 */

import { safeEquals, signToken } from "@/lib/auth/link-signing";
import { getAppUrl } from "@/lib/url";

export const CONFIRM_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

type TokenPurpose = "confirm" | "unsubscribe";

function sign(purpose: TokenPurpose, email: string, issuedAt: number): string {
  return signToken(purpose, email.toLowerCase(), issuedAt);
}

/** Unsubscribe tokens are timeless, so they sign issuedAt = 0. */
export function generateUnsubscribeToken(email: string): string {
  return sign("unsubscribe", email, 0);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  return safeEquals(token, () => generateUnsubscribeToken(email));
}

export function generateConfirmToken(email: string, issuedAt: number): string {
  return sign("confirm", email, issuedAt);
}

/**
 * Rejects a tampered signature and an expired link alike — the caller only
 * needs to know whether to honour the click.
 */
export function verifyConfirmToken(
  email: string,
  token: string,
  issuedAt: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (now - issuedAt > CONFIRM_TOKEN_TTL_MS) return false;
  return safeEquals(token, () => generateConfirmToken(email, issuedAt));
}

export function buildConfirmUrl(email: string, issuedAt: number): string {
  const token = generateConfirmToken(email, issuedAt);
  return `${getAppUrl()}/api/newsletter/confirm?email=${encodeURIComponent(
    email,
  )}&issued=${issuedAt}&token=${token}`;
}

export function buildUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  return `${getAppUrl()}/api/newsletter/unsubscribe?email=${encodeURIComponent(
    email,
  )}&token=${token}`;
}
