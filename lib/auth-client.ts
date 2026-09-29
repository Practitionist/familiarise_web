import { createAuthClient } from "better-auth/react";
import { customSessionClient, twoFactorClient } from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import type { auth } from "@/lib/auth";
import { forgetAuthState } from "@/lib/auth-broadcast";

export const authClient = createAuthClient({
  // Empty string would be a truthy-enough config that breaks URL resolution;
  // coerce to undefined so BetterAuth falls back to the same-origin /api/auth.
  baseURL: process.env.NEXT_PUBLIC_APP_URL || undefined,
  // ssoClient exposes authClient.signIn.sso(), which generates the OIDC PKCE
  // code_verifier/code_challenge pair and persists the verifier so the
  // callback can validate it. A raw POST to /api/auth/sign-in/sso would
  // skip PKCE entirely and break Auth0 / Okta OIDC / Azure AD OIDC flows.
  // `twoFactorClient` mirrors the server-side `twoFactor()` plugin and exposes
  // `authClient.twoFactor.*`. Without it the plugin's endpoints exist on the
  // server but are unreachable from the browser, so `twoFactorEnabled` can
  // never be flipped from false — which would make the mandatory-2FA gate in
  // `lib/auth-helpers.ts` a one-way door. It is registered unconditionally
  // rather than behind a capability check: it adds no cookie and no
  // interceptor, and gating it would mean a component has to guess whether the
  // operator is staff before it can render the enrolment form.
  plugins: [customSessionClient<typeof auth>(), ssoClient(), twoFactorClient()],
  // NOTE (#1856): no `sessionOptions.refetchInterval` here, deliberately.
  // BetterAuth's built-in poll cannot skip hidden tabs and re-renders
  // every consumer 1x/min, yet still reads the cookie cache (so it
  // detects revocation no faster). The visible-tab tick lives in
  // AuthSyncProvider instead: visibility-guarded, authoritative
  // (disableCookieCache), and re-render-free on the happy path.
});

export const { signIn, signUp, useSession, getSession, sendVerificationEmail } =
  authClient;

/**
 * `signOut` is wrapped so the navbar's remembered auth state (name + avatar in
 * localStorage) can never outlive the session on a shared device. Every
 * sign-out call site in the app imports this binding rather than
 * `authClient.signOut`, so clearing here covers all of them — including the
 * paths that hard-navigate away before any effect could run. Clearing before
 * the request also fails safe: if the request errors the next resolved session
 * simply rewrites the cache.
 *
 * Asserted rather than annotated because BetterAuth's `signOut` is generic in
 * its fetch options; a spread wrapper erases that generic and the contextual
 * annotation then fails to match. The runtime behaviour is a straight
 * pass-through, so the assertion is the honest description.
 */
export const signOut = ((...args: Parameters<typeof authClient.signOut>) => {
  forgetAuthState();
  return authClient.signOut(...args);
}) as typeof authClient.signOut;
