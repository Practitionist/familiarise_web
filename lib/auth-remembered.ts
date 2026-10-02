/**
 * The remembered auth shape in localStorage: lets the navbar paint the last
 * known signed-in state on the first frame. Display only, never an
 * authorization signal. SSR-safe (no-ops on the server) and best-effort.
 */

// Last observed authed state. AuthSyncProvider also reads it on a cold load
// to tell a session that died while the tab was closed from a fresh visitor.
const AUTHED_FLAG_KEY = "familiarise.auth_authed";

// Display-only identity for the remembered shape, so the navbar can paint the
// real avatar and name on the first frame instead of a silhouette. Deliberately
// name + image ONLY: no id, no email, no role, no org. Nothing here may ever be
// used as an authorization signal — see `hooks/useRememberedAuth.ts`.
const AUTHED_IDENTITY_KEY = "familiarise.auth_identity";

export type AuthIdentity = { name: string | null; image: string | null };

export function readAuthedFlag(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(AUTHED_FLAG_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
}

export function readAuthedIdentity(): AuthIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTHED_IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { name, image } = parsed as Partial<AuthIdentity>;
    return {
      name: typeof name === "string" ? name : null,
      image: typeof image === "string" ? image : null,
    };
  } catch {
    return null;
  }
}

/**
 * Single choke point for the remembered auth state. Writing `false` ALWAYS
 * removes the cached identity, so a shared or public device can never retain
 * the previous user's name and avatar: the flag and the identity cannot
 * disagree by construction. Every sign-out path in the app reaches this via the
 * wrapped `signOut` in `lib/auth-client.ts`, and `AuthSyncProvider` calls it
 * again on every resolved-null session.
 */
export function writeAuthedFlag(
  authed: boolean,
  identity?: AuthIdentity | null,
): void {
  if (typeof window === "undefined") return;
  try {
    // Clear before writing, never after: if the replacement write throws
    // (quota, Safari private mode) a clear-last order would leave the PREVIOUS
    // account's identity sitting next to a true flag, and the next pending
    // session would paint their name and avatar.
    localStorage.removeItem(AUTHED_IDENTITY_KEY);
    localStorage.setItem(AUTHED_FLAG_KEY, authed ? "true" : "false");
    if (authed && identity) {
      localStorage.setItem(AUTHED_IDENTITY_KEY, JSON.stringify(identity));
    }
  } catch {
    // Best-effort, but the invariant is not optional. Fall back to the
    // signed-out shape, which costs a skeleton frame and leaks nothing.
    try {
      localStorage.removeItem(AUTHED_IDENTITY_KEY);
      localStorage.setItem(AUTHED_FLAG_KEY, "false");
    } catch {
      // Storage is unavailable outright, so nothing was ever cached.
    }
  }
}

/** Sign-out-facing alias; the clear is the point, so say so at the call site. */
export function forgetAuthState(): void {
  writeAuthedFlag(false);
}
