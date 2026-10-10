import { createHmac, timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";

// Better Auth's names: the `__Secure-` prefix rides on https origins.
export const SESSION_TOKEN_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

/**
 * The secret Better Auth signs cookies with: the first (current)
 * `BETTER_AUTH_SECRETS` entry when rotation is configured, else
 * `BETTER_AUTH_SECRET`. Only that one verifies, exactly as in Better Auth.
 */
export function cookieSigningSecret(
  rotated: string | undefined = process.env.BETTER_AUTH_SECRETS,
  legacy: string | undefined = process.env.BETTER_AUTH_SECRET,
): string | null {
  const current = rotated?.split(",")[0]?.trim();
  if (current) {
    const colon = current.indexOf(":");
    const value = colon > 0 ? current.slice(colon + 1).trim() : "";
    return value || null;
  }
  return legacy || null;
}

/**
 * The session token from a correctly signed cookie, else null. better-call
 * signs as `<token>.<base64 HMAC-SHA256(token, secret)>`, URL-encoded.
 */
export function verifiedSessionToken(
  readCookie: (name: string) => string | undefined,
  secret: string | null = cookieSigningSecret(),
): string | null {
  for (const name of SESSION_TOKEN_COOKIES) {
    const raw = readCookie(name);
    if (!raw) continue;
    if (!secret) return null;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const token = value.substring(0, dot);
    const given = Buffer.from(value.substring(dot + 1), "base64");
    const expected = createHmac("sha256", secret).update(token).digest();
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? token
      : null;
  }
  return null;
}

/** A cookie value out of a raw `Cookie` request header. */
export function cookieFromHeader(
  header: string | null,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * Settles a session read that answered null although the browser holds a
 * validly signed cookie. A live row means the lookup did not complete
 * (`failed`); no row or an expired one means the session is gone (`none`).
 * A failing row read is itself `failed`.
 */
export async function classifyMissingSession(
  token: string,
): Promise<"none" | "failed"> {
  let row: { expiresAt: Date } | null;
  try {
    row = await prisma.session.findUnique({
      where: { token },
      select: { expiresAt: true },
    });
  } catch {
    return "failed";
  }
  if (row && row.expiresAt > new Date()) return "failed";
  try {
    const reason = row ? "expired" : "missing";
    Sentry.metrics?.count("auth.stale_session_evicted", 1, {
      attributes: { reason },
    });
  } catch {
    // Telemetry must never fail a session lookup.
  }
  return "none";
}
