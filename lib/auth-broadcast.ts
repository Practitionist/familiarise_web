/**
 * Cross-tab auth sync.
 *
 * BetterAuth's client only broadcasts a session change to other tabs on
 * sign-out / update-user / update-session (better-auth `client/config.mjs`),
 * never on sign-in — and OAuth/SSO complete via a full-page redirect with no
 * client fetch listener at all. So an already-open tab keeps showing
 * logged-out after you log in elsewhere until it next regains focus. We bridge
 * that gap by emitting our own login/logout ping; peer tabs refetch on receipt.
 *
 * Prefers BroadcastChannel and falls back to a `storage`-event ping for
 * browsers without it. SSR-safe (no-ops on the server). Best-effort throughout
 * — a sync failure must never break auth.
 */
export const AUTH_SYNC_CHANNEL = "familiarise.auth";

export type AuthSyncMessage = { type: "login" | "logout" };

// Last observed authed state, shared across tabs via localStorage. Lets a tab
// tell a genuine login (null/false -> true, including the OAuth/SSO full-page
// redirect) apart from a reload of an already-authed user, so a plain refresh
// no longer fires a synthetic broadcast that spams peer-tab refetches.
const AUTHED_FLAG_KEY = "familiarise.auth_authed";

export function readAuthedFlag(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(AUTHED_FLAG_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
}

export function writeAuthedFlag(authed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTHED_FLAG_KEY, authed ? "true" : "false");
  } catch {
    // best-effort — ignore
  }
}

export function postAuthSync(message: AuthSyncMessage): void {
  if (typeof window === "undefined") return;
  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
      channel.postMessage(message);
      channel.close();
      return;
    }
  } catch {
    // fall through to the storage-event fallback
  }
  try {
    // A value change is what fires `storage` in peer tabs, so stamp each ping.
    localStorage.setItem(
      AUTH_SYNC_CHANNEL,
      JSON.stringify({ ...message, t: Date.now() }),
    );
  } catch {
    // best-effort — ignore
  }
}

export function subscribeAuthSync(
  handler: (message: AuthSyncMessage) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const cleanups: Array<() => void> = [];

  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
      const onMessage = (event: MessageEvent) =>
        handler(event.data as AuthSyncMessage);
      channel.addEventListener("message", onMessage);
      cleanups.push(() => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      });
    }
  } catch {
    // ignore — storage fallback below still applies
  }

  // `storage` fires only in OTHER tabs of the same origin, which is exactly the
  // peer-tab signal we want; it also covers browsers without BroadcastChannel.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_SYNC_CHANNEL || !event.newValue) return;
    try {
      handler(JSON.parse(event.newValue) as AuthSyncMessage);
    } catch {
      // ignore malformed payloads
    }
  };
  window.addEventListener("storage", onStorage);
  cleanups.push(() => window.removeEventListener("storage", onStorage));

  return () => cleanups.forEach((fn) => fn());
}
