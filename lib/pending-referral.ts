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

export function setPendingReferral(code: string): void {
  if (typeof window === "undefined" || !code) return;
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // ignore — referral attribution is non-critical
  }
}

export function takePendingReferral(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const code = localStorage.getItem(KEY);
    if (code) localStorage.removeItem(KEY);
    return code;
  } catch {
    return null;
  }
}
