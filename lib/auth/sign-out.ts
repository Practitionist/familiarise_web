import { signOut } from "@/lib/auth-client";
import { forgetAuthState } from "@/lib/auth-remembered";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { isProtectedPath } from "@/lib/navigation/protected-routes";
import { clearSentryIdentity } from "@/lib/observability/identity";
// SDK-free path on purpose (#248): `@/providers/StreamProvider` only
// re-exports this helper, and importing through the provider would drag the
// Stream video/chat SDK into every bundle that signs out (e.g. Navbar).
import { disconnectStreamClients } from "@/lib/stream/disconnect";

const AUTH_CHANNEL = "auth";
const SIGNED_OUT = "signed-out";

/** The sign-in page, returning to the current page afterwards. */
export function signInHref(reason?: "session-revoked"): string {
  const params = new URLSearchParams();
  if (reason) params.set("reason", reason);
  const here = safeSameOriginPath(
    `${window.location.pathname}${window.location.search}`,
  );
  if (here && !here.startsWith("/auth/")) params.set("callbackUrl", here);
  const query = params.toString();
  return query ? `/auth/signin?${query}` : "/auth/signin";
}

async function tearDownLocalSession(): Promise<void> {
  forgetAuthState();
  try {
    await disconnectStreamClients();
  } catch {
    // Best-effort: a failed socket teardown must not block sign-out.
  }
}

/**
 * Sign out from every live surface: tear down Stream sockets, end the
 * better-auth session, tell this browser's other tabs once, and leave with
 * `location.replace` so the signed-in page is not left in history.
 */
export async function signOutEverywhere(redirectTo = "/auth/signin") {
  await tearDownLocalSession();
  signOut({
    fetchOptions: {
      onSuccess: () => {
        broadcastSignedOut();
        window.location.replace(redirectTo);
      },
      onError: () => {
        // The sign-in page re-establishes or rejects the session honestly.
        window.location.replace(redirectTo);
      },
    },
  });
}

/**
 * The session already ended (revoked elsewhere, expired, or signed out in
 * another tab): clear local state and leave, with no second sign-out call.
 */
export async function leaveEndedSession(redirectTo: string): Promise<void> {
  await tearDownLocalSession();
  clearSentryIdentity();
  window.location.replace(redirectTo);
}

/** The cookie now belongs to another user: reload so nothing acts as the old one. */
export function reloadAsSignedInUser(): void {
  window.location.reload();
}

/** Where a tab goes when another tab signed out: sign-in, or reload a public page. */
export async function followSignOutElsewhere(): Promise<void> {
  await tearDownLocalSession();
  clearSentryIdentity();
  if (isProtectedPath(window.location.pathname)) {
    window.location.replace("/auth/signin");
  } else {
    window.location.reload();
  }
}

function broadcastSignedOut(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.postMessage({ type: SIGNED_OUT });
  channel.close();
}

/** Calls `onSignedOut` when another tab of this browser signs out. */
export function subscribeToSignOut(onSignedOut: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === SIGNED_OUT
    ) {
      onSignedOut();
    }
  };
  return () => channel.close();
}
