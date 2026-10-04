import { z } from "zod";

import { REFERRAL_CODE_COOKIE } from "@/lib/referrals/attribution-token-shape";

/**
 * Deferred referral code (client-only).
 *
 * Applying a referral code needs an authenticated session (see
 * `app/api/referrals/apply/route.ts`). With email verification a credential
 * signup no longer creates a session immediately, and OAuth/SSO signups
 * complete through a full-page redirect that drops the `?ref=` param — both
 * would lose the code. We stash it at first touch and apply it once the user
 * lands authenticated on the onboarding page. Best-effort: localStorage may be
 * unavailable (private mode) and the code is lost if the link is opened on a
 * different device — both acceptable.
 */
const KEY = "familiarise.pendingReferral";

// Value validation for the code itself: trim, require non-empty, and bound the
// length so we never persist whitespace or junk that would later cause an
// avoidable /api/referrals/apply 400. (The `typeof window` checks below are SSR
// guards — localStorage doesn't exist on the server — not value validation, so
// they stay outside the schema.) The server remains the source of truth for
// code validity; this is just a cheap client-side normalize.
const referralCodeSchema = z.string().trim().min(1).max(64);

export function setPendingReferral(code: string): void {
  if (typeof window === "undefined") return;
  const parsed = referralCodeSchema.safeParse(code);
  if (!parsed.success) return;
  try {
    localStorage.setItem(KEY, parsed.data);
  } catch {
    // ignore — referral attribution is non-critical
  }
}

/** The `/r/<code>` cookie, which survives an OAuth round trip on another tab. */
function readReferralCookie(): string | null {
  const prefix = `${REFERRAL_CODE_COOKIE}=`;
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
  const parsed = referralCodeSchema.safeParse(
    raw ? decodeURIComponent(raw) : null,
  );
  return parsed.success ? parsed.data : null;
}

export function getPendingReferral(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = referralCodeSchema.safeParse(localStorage.getItem(KEY));
    return parsed.success ? parsed.data : readReferralCookie();
  } catch {
    return readReferralCookie();
  }
}

export function clearPendingReferral(): void {
  if (typeof window === "undefined") return;
  document.cookie = `${REFERRAL_CODE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
