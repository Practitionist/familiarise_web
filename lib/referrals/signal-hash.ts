import { createHmac } from "node:crypto";

import { deriveAuthKey } from "@/lib/auth/link-signing";
import { stampedClientIp } from "@/lib/request-ip";

/** Longest user agent kept on a referral; the column is VarChar(256). */
export const USER_AGENT_MAX = 256;

export type SignalKind = "ip" | "vpa" | "phone";

/** A key bound to referral fraud signals, derived from the auth secret; null when it is unusable. */
function signalKey(): Buffer | null {
  return deriveAuthKey("familiarise/referral-signal-key/v1");
}

/** The value in the form two equal instruments share, or null when there is nothing to compare. */
function canonical(kind: SignalKind, raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (kind === "ip") return value && value !== "unknown_ip" ? value : null;
  if (kind === "vpa") return value.includes("@") ? value : null;
  // Formatting and the country code differ between payers; the last ten digits do not.
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** HMAC of a payer or request signal, so equal instruments compare equal without storing them. */
export function hashSignal(
  kind: SignalKind,
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const value = canonical(kind, raw);
  const key = value ? signalKey() : null;
  if (!value || !key) return null;
  return createHmac("sha256", key)
    .update(`${kind}:${value}`)
    .digest("base64url");
}

/** The user agent as stored on a referral: trimmed and cut to the column width. */
export function truncateUserAgent(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim();
  return value ? value.slice(0, USER_AGENT_MAX) : null;
}

export interface ReferralRequestSignals {
  ipHash: string | null;
  userAgent: string | null;
}

/** The apply request's signals; the IP is only the one middleware stamped. */
export function referralRequestSignals(headers: {
  get(name: string): string | null;
}): ReferralRequestSignals {
  return {
    ipHash: hashSignal("ip", stampedClientIp(headers)),
    userAgent: truncateUserAgent(headers.get("user-agent")),
  };
}
